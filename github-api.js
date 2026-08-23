window.GitHubAPI = (() => {
  const API = 'https://api.github.com';

  async function getToken() {
    return new Promise(resolve => {
      chrome.storage.local.get(['github_token'], d => resolve(d.github_token || null));
    });
  }

  async function request(path, opts = {}) {
    const token = await getToken();
    if (!token) throw new Error('Not authenticated.');
    const res = await fetch(`${API}${path}`, {
      ...opts,
      // Chrome's HTTP cache keys on URL only — a cached raw-Accept response
      // would otherwise be served to a JSON-Accept request for the same URL
      cache: 'no-store',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': opts.accept || 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...opts.headers
      }
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const details = body.errors?.map(e => e.message || JSON.stringify(e)).join('; ') || '';
      throw new Error(`${body.message || 'API error'}${details ? ': ' + details : ''} (${res.status})`);
    }
    return res.json();
  }

  function parsePRUrl(url) {
    const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], repo: m[2], pullNumber: parseInt(m[3]) } : null;
  }

  async function getRawFile(owner, repo, path, ref) {
    const token = await getToken();
    if (!token) throw new Error('Not authenticated.');
    const res = await fetch(`${API}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`, {
      cache: 'no-store',
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3.raw' }
    });
    if (!res.ok) throw new Error(`Failed to fetch file (${res.status})`);
    return res.text();
  }

  async function getPR(owner, repo, num) {
    return request(`/repos/${owner}/${repo}/pulls/${num}`);
  }

  async function graphql(query, variables) {
    const token = await getToken();
    if (!token) throw new Error('Not authenticated.');
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Authorization': `bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.errors) {
      throw new Error(data.errors?.map(e => e.message).join('; ') || `GraphQL error (${res.status})`);
    }
    return data.data;
  }

  // Returns a map: REST comment databaseId -> { threadId, isResolved }
  // so the sidebar can show/resolve threads keyed by the comments it already has.
  async function getReviewThreads(owner, repo, num) {
    const map = {};
    let cursor = null;
    while (true) {
      const data = await graphql(`
        query($owner:String!,$repo:String!,$num:Int!,$cursor:String){
          repository(owner:$owner,name:$repo){
            pullRequest(number:$num){
              reviewThreads(first:100, after:$cursor){
                pageInfo{ hasNextPage endCursor }
                nodes{
                  id isResolved isCollapsed
                  comments(first:100){ nodes{ databaseId } }
                }
              }
            }
          }
        }`, { owner, repo, num, cursor });
      const threads = data.repository.pullRequest.reviewThreads;
      for (const t of threads.nodes) {
        for (const c of t.comments.nodes) {
          if (c.databaseId != null) map[c.databaseId] = { threadId: t.id, isResolved: t.isResolved };
        }
      }
      if (!threads.pageInfo.hasNextPage) break;
      cursor = threads.pageInfo.endCursor;
    }
    return map;
  }

  async function resolveThread(threadId) {
    return graphql(`mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }`, { id: threadId });
  }

  async function unresolveThread(threadId) {
    return graphql(`mutation($id:ID!){ unresolveReviewThread(input:{threadId:$id}){ thread{ id isResolved } } }`, { id: threadId });
  }

  async function getFileMeta(owner, repo, path, ref) {
    return request(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`);
  }

  async function putFile(owner, repo, path, { message, content, sha, branch }) {
    return request(`/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: JSON.stringify({ message, content, sha, branch })
    });
  }

  async function getCollaborators(owner, repo) {
    try {
      return await request(`/repos/${owner}/${repo}/collaborators?per_page=100`);
    } catch { return []; }
  }

  async function getPRFiles(owner, repo, num) {
    const files = [];
    let page = 1;
    while (true) {
      const batch = await request(`/repos/${owner}/${repo}/pulls/${num}/files?per_page=100&page=${page}`);
      files.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return files;
  }

  async function getComments(owner, repo, num) {
    const comments = [];
    let page = 1;
    while (true) {
      const batch = await request(`/repos/${owner}/${repo}/pulls/${num}/comments?per_page=100&page=${page}`);
      comments.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return comments;
  }

  async function postComment(owner, repo, num, { body, commitId, path, line }) {
    return request(`/repos/${owner}/${repo}/pulls/${num}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, commit_id: commitId, path, line, side: 'RIGHT' })
    });
  }

  async function editComment(owner, repo, commentId, body) {
    return request(`/repos/${owner}/${repo}/pulls/comments/${commentId}`, {
      method: 'PATCH',
      body: JSON.stringify({ body })
    });
  }

  async function deleteComment(owner, repo, commentId) {
    const token = await getToken();
    if (!token) throw new Error('Not authenticated.');
    const res = await fetch(`${API}/repos/${owner}/${repo}/pulls/comments/${commentId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      throw new Error(b.message || `Delete failed (${res.status})`);
    }
  }

  async function replyToComment(owner, repo, num, commentId, body) {
    return request(`/repos/${owner}/${repo}/pulls/${num}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, in_reply_to: commentId })
    });
  }

  async function getReviews(owner, repo, num) {
    return request(`/repos/${owner}/${repo}/pulls/${num}/reviews?per_page=100`);
  }

  async function getReviewComments(owner, repo, num, reviewId) {
    return request(`/repos/${owner}/${repo}/pulls/${num}/reviews/${reviewId}/comments?per_page=100`);
  }

  async function createPendingReview(owner, repo, num, commitId) {
    return request(`/repos/${owner}/${repo}/pulls/${num}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ commit_id: commitId })
    });
  }

  async function addReviewComment(owner, repo, num, reviewId, { path, position, body }) {
    return request(`/repos/${owner}/${repo}/pulls/${num}/reviews/${reviewId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ path, position, body })
    });
  }

  async function submitReview(owner, repo, num, reviewId, { event, body }) {
    return request(`/repos/${owner}/${repo}/pulls/${num}/reviews/${reviewId}/events`, {
      method: 'POST',
      body: JSON.stringify({ event, body: body || '' })
    });
  }

  async function deletePendingReview(owner, repo, num, reviewId) {
    return request(`/repos/${owner}/${repo}/pulls/${num}/reviews/${reviewId}`, {
      method: 'DELETE'
    });
  }

  return { request, getToken, parsePRUrl, getRawFile, getFileMeta, putFile, getPR, getPRFiles, getCollaborators, getComments, getReviewThreads, resolveThread, unresolveThread, getReviews, getReviewComments, postComment, editComment, deleteComment, replyToComment, createPendingReview, addReviewComment, submitReview, deletePendingReview };
})();
