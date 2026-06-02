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

    const blockTags = new Set(['H1','H2','H3','H4','H5','H6','P','LI','BLOCKQUOTE','PRE','TABLE','UL','OL','TR']);
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
    assignMissedLines(container, raw);

    return container.innerHTML;
  }

  function tagToTokenType(tag) {
    const map = { H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading',
      P:'paragraph', BLOCKQUOTE:'blockquote', PRE:'code', TABLE:'table', UL:'list', OL:'list', LI:'listitem', TR:'table' };
    return map[tag] || null;
  }

  function tokenTypeMatches(tokenType, blockType) {
    if (tokenType === blockType) return true;
    if (blockType === 'listitem' && tokenType === 'list') return true;
    return false;
  }

  function assignMissedLines(container, raw) {
    const lines = raw.split('\n');
    const usedLines = new Set();
    container.querySelectorAll('[data-line]').forEach(e => usedLines.add(parseInt(e.getAttribute('data-line'))));

    function findLine(text, selectors) {
      container.querySelectorAll(selectors).forEach(node => {
        if (node.getAttribute('data-line')) return;
        const clean = (text || node.textContent).trim().substring(0, 50).toLowerCase().replace(/\s+/g, ' ');
        if (!clean) return;
        for (let i = 0; i < lines.length; i++) {
          if (usedLines.has(i + 1)) continue;
          const lineLower = lines[i].replace(/^[#>*\-+\d.|\s`_\[\]()]+/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
          if (lineLower.length > 3 && clean.startsWith(lineLower.substring(0, 25))) {
            node.setAttribute('data-line', i + 1);
            node.style.position = 'relative';
            usedLines.add(i + 1);
            break;
          }
        }
      });
    }

    findLine(null, 'li:not([data-line])');
    findLine(null, 'h1:not([data-line]),h2:not([data-line]),h3:not([data-line]),h4:not([data-line]),h5:not([data-line]),h6:not([data-line])');
    findLine(null, 'p:not([data-line])');

    // Table rows: match by pipe-separated cell content
    container.querySelectorAll('tr').forEach(tr => {
      if (tr.getAttribute('data-line')) return;
      const cells = [...tr.querySelectorAll('td, th')].map(c => c.textContent.trim().toLowerCase()).filter(Boolean);
      if (cells.length === 0) return;
      const needle = cells[0].substring(0, 20);
      for (let i = 0; i < lines.length; i++) {
        if (usedLines.has(i + 1)) continue;
        if (!lines[i].includes('|')) continue;
        const lineLower = lines[i].toLowerCase();
        if (lineLower.includes(needle)) {
          tr.setAttribute('data-line', i + 1);
          tr.style.position = 'relative';
          usedLines.add(i + 1);
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

  function getCommentLine(c) {
    return c.line || c.original_line || c.position || 0;
  }

  async function renderCommentsSidebar(filePath) {
    const fileComments = comments.filter(c => c.path === filePath);
    const list = el.querySelector('#mdr-sidebar-list');
    const currentUser = await getCurrentUser();

    el.querySelector('.mdr-sidebar-header').textContent = `Comments (${fileComments.length})`;

    // Highlight commented lines in content
    highlightCommentedLines(filePath);

    if (fileComments.length === 0) {
      list.innerHTML = '<span class="mdr-sidebar-empty">No comments on this file</span>';
      return;
    }

    // Build threads: root comments + replies
    const roots = fileComments.filter(c => !c.in_reply_to_id);
    const replyMap = new Map(); // rootId -> [replies]
    fileComments.filter(c => c.in_reply_to_id).forEach(c => {
      const arr = replyMap.get(c.in_reply_to_id) || [];
      arr.push(c);
      replyMap.set(c.in_reply_to_id, arr);
    });

    // Group by line, sort by line number
    const lineGroups = new Map(); // line -> [root comments]
    roots.forEach(c => {
      const line = getCommentLine(c);
      const arr = lineGroups.get(line) || [];
      arr.push(c);
      lineGroups.set(line, arr);
    });
    const sortedLines = [...lineGroups.keys()].sort((a, b) => a - b);

    let html = '';
    for (const line of sortedLines) {
      const group = lineGroups.get(line);
      group.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      html += `<div class="mdr-line-group" data-group-line="${line}">`;
      html += `<div class="mdr-line-group-header" data-line="${line}">Line ${line}</div>`;

      for (const root of group) {
        const replies = (replyMap.get(root.id) || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const hasReplies = replies.length > 0;

        html += renderCommentCard(root, currentUser, false);

        if (hasReplies) {
          html += `<div class="mdr-thread-toggle" data-thread="${root.id}">
            <span class="mdr-thread-arrow">&#9654;</span> ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'}
          </div>`;
          html += `<div class="mdr-thread-replies" id="mdr-thread-${root.id}" hidden>`;
          for (const reply of replies) {
            html += renderCommentCard(reply, currentUser, true);
          }
          html += `</div>`;
        }

        html += `<button class="mdr-ca-btn mdr-ca-reply" data-reply-to="${root.id}" data-line="${getCommentLine(root)}">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6.78 1.97a.75.75 0 0 1 0 1.06L3.81 6h6.44A4.75 4.75 0 0 1 15 10.75v2.5a.75.75 0 0 1-1.5 0v-2.5a3.25 3.25 0 0 0-3.25-3.25H3.81l2.97 2.97a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L1.47 7.28a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"/></svg>
          Reply
        </button>`;
      }
      html += `</div>`;
    }

    list.innerHTML = html;

    // --- Event listeners ---

    // Thread toggles
    list.querySelectorAll('.mdr-thread-toggle').forEach(toggle => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const threadId = toggle.getAttribute('data-thread');
        const replies = el.querySelector(`#mdr-thread-${threadId}`);
        const arrow = toggle.querySelector('.mdr-thread-arrow');
        if (replies.hidden) {
          replies.hidden = false;
          arrow.innerHTML = '&#9660;';
        } else {
          replies.hidden = true;
          arrow.innerHTML = '&#9654;';
        }
      });
    });

    // Line group headers → scroll to line
    list.querySelectorAll('.mdr-line-group-header').forEach(header => {
      header.addEventListener('click', () => scrollToLine(header.getAttribute('data-line')));
    });

    // Comment cards → scroll to line
    list.querySelectorAll('.mdr-comment-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.mdr-ca-btn') || e.target.closest('.mdr-edit-form') || e.target.closest('.mdr-delete-confirm')) return;
        scrollToLine(card.getAttribute('data-line'));
      });
    });

    // Edit buttons
    list.querySelectorAll('.mdr-ca-edit').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = parseInt(btn.getAttribute('data-id'));
        const c = comments.find(c => c.id === id);
        if (c) startEdit(id, c.body);
      });
    });

    // Delete buttons
    list.querySelectorAll('.mdr-ca-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        confirmDelete(parseInt(btn.getAttribute('data-id')));
      });
    });

    // Reply buttons
    list.querySelectorAll('.mdr-ca-reply').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openReplyForm(parseInt(btn.getAttribute('data-reply-to')), parseInt(btn.getAttribute('data-line')));
      });
    });
  }

  function renderCommentCard(c, currentUser, isReply) {
    const isOwner = currentUser && c.user.login === currentUser;
    const line = getCommentLine(c);
    const color = getUserColor(c.user.login);
    return `
      <div class="mdr-comment-card ${isReply ? 'mdr-reply-card' : ''}" data-comment-id="${c.id}" data-line="${line}" style="border-left: 3px solid ${color}">
        <div class="mdr-comment-meta">
          <img src="${c.user.avatar_url}" class="mdr-comment-avatar" style="border-color:${color}" alt="">
          <strong style="color:${color}">${c.user.login}</strong>
          ${!isReply ? `<span class="mdr-comment-line">L${line}</span>` : ''}
          <span class="mdr-comment-time">${timeAgo(c.created_at)}</span>
        </div>
        <div class="mdr-comment-body" id="mdr-cbody-${c.id}">${escapeHtml(c.body)}</div>
        ${isOwner ? `<div class="mdr-comment-actions">
          <button class="mdr-ca-btn mdr-ca-edit" data-id="${c.id}">Edit</button>
          <button class="mdr-ca-btn mdr-ca-delete" data-id="${c.id}">Delete</button>
        </div>` : ''}
      </div>`;
  }

  function scrollToLine(line) {
    const target = el.querySelector(`.mdr-markdown [data-line="${line}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('mdr-flash');
      setTimeout(() => target.classList.remove('mdr-flash'), 1500);
    }
  }

  // Assign stable colors to users
  const userColors = [
    '#6366f1', '#ec4899', '#f59e0b', '#10b981', '#ef4444',
    '#8b5cf6', '#06b6d4', '#f97316', '#14b8a6', '#e11d48'
  ];
  const userColorMap = new Map();

  function getUserColor(login) {
    if (userColorMap.has(login)) return userColorMap.get(login);
    const color = userColors[userColorMap.size % userColors.length];
    userColorMap.set(login, color);
    return color;
  }

  function highlightCommentedLines(filePath) {
    // Clear old highlights and badges
    el.querySelectorAll('[data-has-comment]').forEach(e => e.removeAttribute('data-has-comment'));
    el.querySelectorAll('.mdr-inline-badge').forEach(b => b.remove());

    const fileComments = comments.filter(c => c.path === filePath);

    // Group comments by line
    const byLine = new Map();
    fileComments.forEach(c => {
      const line = getCommentLine(c);
      const arr = byLine.get(line) || [];
      arr.push(c);
      byLine.set(line, arr);
    });

    byLine.forEach((lineComments, line) => {
      const target = el.querySelector(`.mdr-markdown [data-line="${line}"]`);
      if (!target) return;

      target.setAttribute('data-has-comment', 'true');

      // Remove existing badge if any
      target.querySelector('.mdr-inline-badge')?.remove();

      // Create inline badge showing comment count + user avatars
      const badge = document.createElement('button');
      badge.className = 'mdr-inline-badge';
      badge.title = `${lineComments.length} comment${lineComments.length > 1 ? 's' : ''} — click to view`;

      const uniqueUsers = [...new Map(lineComments.map(c => [c.user.login, c.user])).values()];
      const avatars = uniqueUsers.slice(0, 3).map(u =>
        `<img src="${u.avatar_url}" class="mdr-badge-avatar" alt="${u.login}" style="border-color:${getUserColor(u.login)}">`
      ).join('');

      badge.innerHTML = `${avatars}<span class="mdr-badge-count">${lineComments.length}</span>`;

      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        // Scroll sidebar to this line's comment group
        const group = el.querySelector(`.mdr-line-group[data-group-line="${line}"]`);
        if (group) {
          group.scrollIntoView({ behavior: 'smooth', block: 'start' });
          group.classList.add('mdr-flash');
          setTimeout(() => group.classList.remove('mdr-flash'), 1500);
        }
      });

      target.appendChild(badge);
    });
  }

  function openReplyForm(replyToId, line) {
    // Remove any existing reply form
    el.querySelectorAll('.mdr-reply-form').forEach(f => f.remove());

    const btn = el.querySelector(`.mdr-ca-reply[data-reply-to="${replyToId}"]`);
    if (!btn) return;

    const form = document.createElement('div');
    form.className = 'mdr-reply-form mdr-inline-form';
    form.innerHTML = `
      <textarea class="mdr-inline-textarea" placeholder="Write a reply..." autofocus></textarea>
      <div class="mdr-inline-actions">
        <button class="mdr-btn-cancel">Cancel</button>
        <button class="mdr-btn-submit">Reply</button>
      </div>`;

    btn.after(form);
    const ta = form.querySelector('textarea');
    const sub = form.querySelector('.mdr-btn-submit');
    setTimeout(() => ta.focus(), 50);

    form.querySelector('.mdr-btn-cancel').addEventListener('click', (e) => { e.stopPropagation(); form.remove(); });
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sub.click();
      if (e.key === 'Escape') form.remove();
    });

    sub.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = ta.value.trim();
      if (!text) { ta.style.borderColor = '#ef4444'; return; }
      sub.disabled = true; sub.textContent = 'Posting...';
      try {
        const newComment = await GitHubAPI.replyToComment(pr.owner, pr.repo, pr.pullNumber, replyToId, text);
        comments.push(newComment);
        form.remove();
        renderCommentsSidebar(fileData.filePath);
        toast('Reply posted');
      } catch (err) {
        sub.disabled = false; sub.textContent = 'Reply';
        toast(err.message, 'error');
      }
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
