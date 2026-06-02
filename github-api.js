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
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3.raw' }
    });
    if (!res.ok) throw new Error(`Failed to fetch file (${res.status})`);
    return res.text();
  }

  async function getPR(owner, repo, num) {
    return request(`/repos/${owner}/${repo}/pulls/${num}`);
  }

  async function getPRFiles(owner, repo, num) {
    return request(`/repos/${owner}/${repo}/pulls/${num}/files?per_page=100`);
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

  async function postComment(owner, repo, num, { body, commitId, path, position }) {
    return request(`/repos/${owner}/${repo}/pulls/${num}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body, commit_id: commitId, path, position })
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

  async function createPendingReview(owner, repo, num, commitId) {
    return request(`/repos/${owner}/${repo}/pulls/${num}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ commit_id: commitId, event: 'PENDING' })
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

  return { request, getToken, parsePRUrl, getRawFile, getPR, getPRFiles, getComments, postComment, editComment, deleteComment, replyToComment, createPendingReview, addReviewComment, submitReview, deletePendingReview };
})();
