if (typeof window.MDROverlay !== 'undefined') { /* already loaded */ } else
window.MDROverlay = (() => {
  let pr = null;
  let files = null;
  let fileData = null;
  let el = null;
  let comments = [];

  function toast(msg, type = 'success') {
    document.querySelectorAll('.mdr-toast').forEach(t => t.remove());
    const t = document.createElement('div');
    t.className = `mdr-toast mdr-toast-${type}`;
    t.innerHTML = `<span>${{success:'\u2713',error:'\u2717',info:'\u2139'}[type]||''}</span><span>${msg}</span>`;
    document.body.appendChild(t);
    setTimeout(() => { t.style.animation = 'mdr-toast-out 0.2s ease-in forwards'; setTimeout(() => t.remove(), 200); }, 3500);
  }

  async function open(prData) {
    if (el) close();
    pr = prData;
    files = prData.files;

    el = document.createElement('div');
    el.className = 'mdr-overlay';
    el.setAttribute('data-theme', await getTheme());
    el.innerHTML = shell();
    document.body.appendChild(el);
    document.body.style.overflow = 'hidden';

    el.querySelector('#mdr-close').addEventListener('click', close);
    el.querySelector('#mdr-theme-toggle').addEventListener('click', toggleTheme);
    document.addEventListener('keydown', onEsc);

    await loadPR();
  }

  function close() {
    el?.remove(); el = null;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onEsc);
  }

  function onEsc(e) { if (e.key === 'Escape' && !el?.querySelector('.mdr-inline-form')) close(); }

  async function getTheme() {
    return new Promise(r => chrome.storage.local.get(['mdr_theme'], d => {
      r(d.mdr_theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    }));
  }

  function toggleTheme() {
    const current = el.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    el.setAttribute('data-theme', next);
    chrome.storage.local.set({ mdr_theme: next });
    el.querySelector('#mdr-theme-toggle').textContent = next === 'dark' ? '\u2600' : '\u263D';
  }

  function shell() {
    return `
      <div class="mdr-topbar">
        <div class="mdr-topbar-left">
          <div class="mdr-topbar-logo">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="rgba(255,255,255,0.2)"/><path d="M6 8h12M6 12h8M6 16h10" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>
            MD Reviewer
          </div>
          <span class="mdr-topbar-pr" id="mdr-pr-info">Loading...</span>
        </div>
        <div class="mdr-topbar-right">
          <select class="mdr-file-select" id="mdr-file-select" disabled><option>Loading...</option></select>
          <button class="mdr-theme-btn" id="mdr-theme-toggle" title="Toggle dark/light mode">\u263D</button>
          <button class="mdr-close-btn" id="mdr-close" title="Close (Esc)">&times;</button>
        </div>
      </div>
      <div class="mdr-statsbar" id="mdr-statsbar"><span>Loading...</span></div>
      <div class="mdr-body">
        <div class="mdr-content" id="mdr-content">
          <div class="mdr-loading"><div class="mdr-spinner"></div><span>Loading...</span></div>
        </div>
        <div class="mdr-sidebar" id="mdr-sidebar">
          <div class="mdr-sidebar-header">Comments</div>
          <div class="mdr-sidebar-list" id="mdr-sidebar-list"><span class="mdr-sidebar-empty">No comments yet</span></div>
        </div>
      </div>`;
  }

  async function loadPR() {
    try {
      el.querySelector('#mdr-pr-info').textContent = `PR #${pr.pullNumber} · ${pr.owner}/${pr.repo}`;
      const select = el.querySelector('#mdr-file-select');
      select.innerHTML = files.map(f => `<option value="${f.filename}">${f.filename.split('/').pop()} (+${f.additions})</option>`).join('');
      select.disabled = false;
      select.addEventListener('change', () => loadFile(select.value));

      comments = await GitHubAPI.getComments(pr.owner, pr.repo, pr.pullNumber);

      if (files.length > 0) loadFile(files[0].filename);
    } catch (err) {
      setContent(`<div class="mdr-loading"><span class="mdr-error">${err.message}</span></div>`);
    }
  }

  async function loadFile(filePath) {
    setContent('<div class="mdr-loading"><div class="mdr-spinner"></div><span>Rendering...</span></div>');
    try {
      const raw = await GitHubAPI.getRawFile(pr.owner, pr.repo, filePath, pr.headRef);
      const lineMap = buildLineMap(raw);
      const html = renderWithLines(raw, lineMap);

      fileData = { filePath, raw, lineMap };
      setContent(`<div class="mdr-markdown">${html}</div>`);

      const file = files.find(f => f.filename === filePath);
      const blockCount = el.querySelectorAll('[data-line]').length;
      el.querySelector('#mdr-statsbar').innerHTML =
        `<span>${blockCount} blocks</span><span>+${file.additions} lines</span><span>All commentable</span>`;

      renderCommentsSidebar(filePath);
      attachCommentButtons();
    } catch (err) {
      setContent(`<div class="mdr-loading"><span class="mdr-error">${err.message}</span></div>`);
    }
  }

  // --- Line mapping via marked tokenizer ---

  function buildLineMap(raw) {
    const tokens = marked.lexer(raw);
    const map = []; // array of { tokenIndex, startLine, raw }
    let offset = 0;

    function getLineAt(charOffset) {
      let line = 1;
      for (let i = 0; i < charOffset && i < raw.length; i++) {
        if (raw[i] === '\n') line++;
      }
      return line;
    }

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok.raw) continue;
      const idx = raw.indexOf(tok.raw, offset);
      if (idx === -1) continue;
      const line = getLineAt(idx);
      map.push({ index: i, type: tok.type, startLine: line, text: tok.raw.substring(0, 80) });
      offset = idx + tok.raw.length;
    }

    return map;
  }

  function renderWithLines(raw, lineMap) {
    const html = marked.parse(raw, { gfm: true, breaks: false });
    const container = document.createElement('div');
    container.innerHTML = html;

    const blockTags = new Set(['H1','H2','H3','H4','H5','H6','P','LI','BLOCKQUOTE','PRE','TABLE','UL','OL']);
    const topBlocks = [];

    // Collect top-level block elements in document order
    function collectBlocks(parent) {
      for (const child of parent.children) {
        if (blockTags.has(child.tagName)) {
          topBlocks.push(child);
          if (child.tagName === 'UL' || child.tagName === 'OL') {
            for (const li of child.querySelectorAll('li')) {
              topBlocks.push(li);
            }
          }
        }
      }
    }
    collectBlocks(container);

    // Map tokens to block elements sequentially
    // Token types: heading, paragraph, list, blockquote, code, table, space, hr
    let mapIdx = 0;
    for (const block of topBlocks) {
      if (mapIdx >= lineMap.length) break;
      const tag = block.tagName;

      // Find the next matching token type
      const blockType = tagToTokenType(tag);
      if (!blockType) continue;

      for (let j = mapIdx; j < lineMap.length; j++) {
        if (tokenTypeMatches(lineMap[j].type, blockType)) {
          block.setAttribute('data-line', lineMap[j].startLine);
          block.style.position = 'relative';

          // For list items, find sub-items in the list token
          if (lineMap[j].type === 'list' && tag === 'LI') {
            // LI elements come from list tokens — assign line from list items within
          }

          mapIdx = j + 1;
          break;
        }
      }
    }

    // Second pass: assign lines to LI elements that didn't get one
    // by interpolating from their parent list and raw source
    assignListItemLines(container, raw);

    return container.innerHTML;
  }

  function tagToTokenType(tag) {
    const map = { H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading',
      P:'paragraph', BLOCKQUOTE:'blockquote', PRE:'code', TABLE:'table', UL:'list', OL:'list', LI:'listitem' };
    return map[tag] || null;
  }

  function tokenTypeMatches(tokenType, blockType) {
    if (tokenType === blockType) return true;
    if (blockType === 'listitem' && tokenType === 'list') return true;
    return false;
  }

  function assignListItemLines(container, raw) {
    const lines = raw.split('\n');

    container.querySelectorAll('li').forEach(li => {
      if (li.getAttribute('data-line')) return;

      const text = li.textContent.trim().substring(0, 40);
      if (!text) return;

      // Search raw lines for this text
      const cleanText = text.toLowerCase().replace(/\s+/g, ' ');
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].toLowerCase().replace(/[*_`\[\]()#>-]/g, '').replace(/^\s*\d+\.\s*/, '').replace(/\s+/g, ' ').trim();
        if (lineLower && cleanText.startsWith(lineLower.substring(0, 25))) {
          li.setAttribute('data-line', i + 1);
          li.style.position = 'relative';
          break;
        }
      }
    });

    // Also handle paragraphs/headings that missed the first pass
    container.querySelectorAll('h1,h2,h3,h4,h5,h6,p').forEach(el => {
      if (el.getAttribute('data-line')) return;
      const text = el.textContent.trim().substring(0, 50).toLowerCase().replace(/\s+/g, ' ');
      if (!text) return;
      for (let i = 0; i < lines.length; i++) {
        const lineLower = lines[i].replace(/^#+\s*/, '').replace(/[*_`\[\]()]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (lineLower && text.startsWith(lineLower.substring(0, 30))) {
          el.setAttribute('data-line', i + 1);
          el.style.position = 'relative';
          break;
        }
      }
    });
  }

  // --- Comment sidebar ---

  async function getCurrentUser() {
    if (renderCommentsSidebar._user) return renderCommentsSidebar._user;
    try {
      const data = await new Promise(r => chrome.storage.local.get(['github_user'], d => r(d.github_user)));
      renderCommentsSidebar._user = data?.login || null;
      return renderCommentsSidebar._user;
    } catch { return null; }
  }

  async function renderCommentsSidebar(filePath) {
    const fileComments = comments.filter(c => c.path === filePath);
    const list = el.querySelector('#mdr-sidebar-list');
    const currentUser = await getCurrentUser();

    el.querySelector('.mdr-sidebar-header').textContent = `Comments (${fileComments.length})`;

    if (fileComments.length === 0) {
      list.innerHTML = '<span class="mdr-sidebar-empty">No comments on this file</span>';
      return;
    }

    list.innerHTML = fileComments.map(c => {
      const isOwner = currentUser && c.user.login === currentUser;
      const line = c.line || c.original_line || c.position || '?';
      return `
        <div class="mdr-comment-card" data-comment-id="${c.id}" data-line="${line}">
          <div class="mdr-comment-meta">
            <img src="${c.user.avatar_url}" class="mdr-comment-avatar" alt="">
            <strong>${c.user.login}</strong>
            <span class="mdr-comment-line">L${line}</span>
            <span class="mdr-comment-time">${timeAgo(c.created_at)}</span>
          </div>
          <div class="mdr-comment-body" id="mdr-cbody-${c.id}">${escapeHtml(c.body)}</div>
          ${isOwner ? `
            <div class="mdr-comment-actions">
              <button class="mdr-ca-btn mdr-ca-edit" data-id="${c.id}" title="Edit">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm1.06 1.06L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 0 0 0-.354l-1.086-1.086a.25.25 0 0 0-.354 0Z"/></svg>
                Edit
              </button>
              <button class="mdr-ca-btn mdr-ca-delete" data-id="${c.id}" title="Delete">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z"/></svg>
                Delete
              </button>
            </div>
          ` : ''}
        </div>`;
    }).join('');

    // Click card body to scroll to line
    list.querySelectorAll('.mdr-comment-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.mdr-ca-btn') || e.target.closest('.mdr-edit-form')) return;
        const line = card.getAttribute('data-line');
        const target = el.querySelector(`[data-line="${line}"]`);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('mdr-flash');
          setTimeout(() => target.classList.remove('mdr-flash'), 1500);
        }
      });
    });

    // Edit buttons
    list.querySelectorAll('.mdr-ca-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.getAttribute('data-id'));
        const comment = comments.find(c => c.id === id);
        if (comment) startEdit(id, comment.body);
      });
    });

    // Delete buttons
    list.querySelectorAll('.mdr-ca-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.getAttribute('data-id'));
        confirmDelete(id);
      });
    });
  }

  function startEdit(commentId, currentBody) {
    const bodyEl = el.querySelector(`#mdr-cbody-${commentId}`);
    if (!bodyEl) return;
    const card = bodyEl.closest('.mdr-comment-card');

    bodyEl.innerHTML = `
      <div class="mdr-edit-form">
        <textarea class="mdr-inline-textarea mdr-edit-textarea">${escapeHtml(currentBody)}</textarea>
        <div class="mdr-inline-actions">
          <button class="mdr-btn-cancel mdr-edit-cancel">Cancel</button>
          <button class="mdr-btn-submit mdr-edit-save">Save</button>
        </div>
      </div>`;

    const ta = bodyEl.querySelector('textarea');
    const saveBtn = bodyEl.querySelector('.mdr-edit-save');
    const cancelBtn = bodyEl.querySelector('.mdr-edit-cancel');

    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      bodyEl.textContent = currentBody;
    });

    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveBtn.click();
      if (e.key === 'Escape') { e.stopPropagation(); bodyEl.textContent = currentBody; }
    });

    saveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newBody = ta.value.trim();
      if (!newBody) return;
      saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
      try {
        await GitHubAPI.editComment(pr.owner, pr.repo, commentId, newBody);
        const c = comments.find(c => c.id === commentId);
        if (c) c.body = newBody;
        renderCommentsSidebar(fileData.filePath);
        toast('Comment updated');
      } catch (err) {
        saveBtn.disabled = false; saveBtn.textContent = 'Save';
        toast(err.message, 'error');
      }
    });
  }

  function confirmDelete(commentId) {
    const card = el.querySelector(`[data-comment-id="${commentId}"]`);
    if (!card) return;

    const existing = card.querySelector('.mdr-delete-confirm');
    if (existing) { existing.remove(); return; }

    const confirm = document.createElement('div');
    confirm.className = 'mdr-delete-confirm';
    confirm.innerHTML = `
      <span>Delete this comment?</span>
      <button class="mdr-btn-submit mdr-dc-yes">Delete</button>
      <button class="mdr-btn-cancel mdr-dc-no">Cancel</button>`;
    card.appendChild(confirm);

    confirm.querySelector('.mdr-dc-no').addEventListener('click', (e) => {
      e.stopPropagation(); confirm.remove();
    });

    confirm.querySelector('.mdr-dc-yes').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.target; btn.disabled = true; btn.textContent = 'Deleting...';
      try {
        await GitHubAPI.deleteComment(pr.owner, pr.repo, commentId);
        comments = comments.filter(c => c.id !== commentId);
        renderCommentsSidebar(fileData.filePath);
        toast('Comment deleted');
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Delete';
        toast(err.message, 'error');
      }
    });
  }

  // --- Comment buttons + inline form ---

  function attachCommentButtons() {
    el.querySelectorAll('[data-line]').forEach(block => {
      if (block.querySelector('.mdr-comment-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'mdr-comment-btn';
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2v2.19l2.72-2.72.53-.22h4.25a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75z"/></svg>`;
      btn.title = `Comment on line ${block.getAttribute('data-line')}`;
      btn.addEventListener('click', e => { e.stopPropagation(); openForm(block); });
      block.appendChild(btn);
    });
  }

  function openForm(block) {
    el.querySelectorAll('.mdr-inline-form').forEach(f => f.remove());
    const line = parseInt(block.getAttribute('data-line'));
    const form = document.createElement('div');
    form.className = 'mdr-inline-form';
    form.innerHTML = `
      <div class="mdr-inline-header">Line ${line}</div>
      <textarea class="mdr-inline-textarea" placeholder="Leave a comment..." autofocus></textarea>
      <div class="mdr-inline-actions">
        <button class="mdr-btn-cancel">Cancel</button>
        <button class="mdr-btn-submit">Submit</button>
      </div>`;

    block.after(form);
    const ta = form.querySelector('textarea');
    const sub = form.querySelector('.mdr-btn-submit');
    setTimeout(() => ta.focus(), 50);

    form.querySelector('.mdr-btn-cancel').addEventListener('click', () => form.remove());
    ta.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sub.click();
      if (e.key === 'Escape') form.remove();
    });

    sub.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text) { ta.style.borderColor = '#ef4444'; return; }
      sub.disabled = true; sub.textContent = 'Posting...';
      try {
        const newComment = await GitHubAPI.postComment(pr.owner, pr.repo, pr.pullNumber, {
          body: text, commitId: pr.headSha, path: fileData.filePath, position: line
        });
        comments.push(newComment);
        form.remove();
        renderCommentsSidebar(fileData.filePath);
        toast('Comment posted');
      } catch (err) {
        sub.disabled = false; sub.textContent = 'Submit';
        toast(err.message, 'error');
      }
    });
  }

  // --- Helpers ---

  function setContent(html) { if (el) el.querySelector('#mdr-content').innerHTML = html; }

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function timeAgo(dateStr) {
    const s = Math.floor((Date.now() - new Date(dateStr)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return `${Math.floor(s/86400)}d ago`;
  }

  return { open, close };
})();
