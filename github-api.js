if (typeof window.GitHubAPI !== 'undefined') { /* already loaded */ } else
window.GitHubAPI = (() => {
  const API_BASE = 'https://api.github.com';

  async function getToken() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['github_token'], (data) => {
        resolve(data.github_token || null);
      });
    });
  }

  async function request(endpoint, options = {}) {
    const token = await getToken();
    if (!token) throw new Error('Not authenticated.');

    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...options.headers
      }
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const details = body.errors ? body.errors.map(e => e.message || JSON.stringify(e)).join('; ') : '';
      throw new Error(`${body.message || 'GitHub API error'}${details ? ': ' + details : ''} (${res.status})`);
    }

    return res.json();
  }

  function parsePRUrl(url) {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], pullNumber: parseInt(match[3]) };
  }

  async function getRawFileContent(owner, repo, path, ref) {
    const token = await getToken();
    if (!token) throw new Error('Not authenticated.');
    const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${ref}`, {
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3.raw' }
    });
    if (!res.ok) throw new Error(`Failed to fetch file: ${res.status}`);
    return res.text();
  }

  async function getPullRequest(owner, repo, pullNumber) {
    return request(`/repos/${owner}/${repo}/pulls/${pullNumber}`);
  }

  async function getPullRequestFiles(owner, repo, pullNumber) {
    return request(`/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100`);
  }

  // Parse a unified diff patch into a map: newFileLine -> diffPosition
  // The "position" is a 1-indexed line number within the patch text itself.
  function buildDiffPositionMap(patch) {
    if (!patch) return null;

    const lines = patch.split('\n');
    const lineToPosition = new Map(); // newFileLine -> position in patch
    let newLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const position = i; // 0-indexed line in the patch; @@ headers count as lines

      const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunkMatch) {
        newLine = parseInt(hunkMatch[1]);
        continue;
      }

      if (line.startsWith('+')) {
        lineToPosition.set(newLine, position);
        newLine++;
      } else if (line.startsWith(' ')) {
        lineToPosition.set(newLine, position);
        newLine++;
      } else if (line.startsWith('-')) {
        // deleted line — has a position but no new-file line number
      }
    }

    return lineToPosition;
  }

  // Find the nearest line in the diff for a given source line
  function findNearestDiffPosition(targetLine, lineToPosition) {
    if (lineToPosition.has(targetLine)) {
      return { line: targetLine, position: lineToPosition.get(targetLine), exact: true };
    }

    // Search outward for nearest line that IS in the diff
    for (let offset = 1; offset <= 100; offset++) {
      if (lineToPosition.has(targetLine + offset)) {
        return { line: targetLine + offset, position: lineToPosition.get(targetLine + offset), exact: false };
      }
      if (lineToPosition.has(targetLine - offset)) {
        return { line: targetLine - offset, position: lineToPosition.get(targetLine - offset), exact: false };
      }
    }

    return null;
  }

  // Create a review comment using the position-based API
  async function createReviewComment(owner, repo, pullNumber, { body, commitId, path, position }) {
    return request(`/repos/${owner}/${repo}/pulls/${pullNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        body,
        commit_id: commitId,
        path,
        position
      })
    });
  }

  // Create a review with inline comments (fallback)
  async function createReviewWithComment(owner, repo, pullNumber, { body, path, position, commitId }) {
    return request(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, {
      method: 'POST',
      body: JSON.stringify({
        commit_id: commitId,
        event: 'COMMENT',
        comments: [{
          path,
          position,
          body
        }]
      })
    });
  }

  return {
    getToken,
    parsePRUrl,
    getRawFileContent,
    getPullRequest,
    getPullRequestFiles,
    buildDiffPositionMap,
    findNearestDiffPosition,
    createReviewComment,
    createReviewWithComment
  };
})();
