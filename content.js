(() => {
  const VERSION = 8;
  if (window.__MDR_VERSION__ === VERSION) {
    if (window.__MDR_REINIT__) window.__MDR_REINIT__();
    return;
  }
  window.__MDR_VERSION__ = VERSION;

  let prData = null;

  async function init() {
    const token = await GitHubAPI.getToken();
    if (!token) return;

    const parsed = GitHubAPI.parsePRUrl(window.location.href);
    if (!parsed) return;

    try {
      const [pr, files] = await Promise.all([
        GitHubAPI.getPR(parsed.owner, parsed.repo, parsed.pullNumber),
        GitHubAPI.getPRFiles(parsed.owner, parsed.repo, parsed.pullNumber)
      ]);
      // Deleted files can't be viewed at head or commented on the RIGHT side
      const mdFiles = files.filter(f => /\.(md|markdown|mdx)$/i.test(f.filename) && f.status !== 'removed');
      if (mdFiles.length === 0) return;

      prData = { ...parsed, headSha: pr.head.sha, headRef: pr.head.ref, files: mdFiles };
      injectButton(mdFiles.length);
    } catch (err) {
      console.error('[MD Reviewer]', err);
    }
  }

  function injectButton(count) {
    if (document.getElementById('mdr-floating-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'mdr-floating-btn';
    btn.className = 'mdr-floating-btn';
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 8h12M6 12h8M6 16h10"/></svg> MD Review <span class="mdr-floating-badge">${count}</span>`;
    btn.addEventListener('click', () => MDROverlay.open(prData));
    document.body.appendChild(btn);
  }

  window.__MDR_REINIT__ = () => {
    document.getElementById('mdr-floating-btn')?.remove();
    prData = null;
    setTimeout(init, 300);
  };

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'TOKEN_UPDATED') {
      document.getElementById('mdr-floating-btn')?.remove();
      prData = null;
      setTimeout(init, 300);
    }
  });

  setTimeout(init, 300);
})();
