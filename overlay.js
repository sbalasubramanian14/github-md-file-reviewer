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

    // Assign data-line to ALL block elements using direct text search
    // against raw markdown lines. This is more reliable than sequential
    // token matching which drifts when tokens don't align 1:1 with DOM.
    assignAllLines(container, raw);

    return container.innerHTML;
  }

  function stripMarkdown(text) {
    return text
      .replace(/^#{1,6}\s+/, '')       // heading prefix
      .replace(/^[\s>*+\-\d.]+/, '')   // list/blockquote prefix (leading only)
      .replace(/\*\*(.+?)\*\*/g, '$1') // bold
      .replace(/\*(.+?)\*/g, '$1')     // italic
      .replace(/__(.+?)__/g, '$1')     // bold
      .replace(/_(.+?)_/g, '$1')       // italic
      .replace(/`([^`]+)`/g, '$1')     // inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
      .replace(/[()]/g, '')            // parens
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function assignAllLines(container, raw) {
    const lines = raw.split('\n');
    const cleanLines = lines.map(l => stripMarkdown(l));
    const usedLines = new Set();
    // Also strip pipe-delimited lines for table matching
    const cleanPipeLines = lines.map(l => {
      if (!l.includes('|')) return '';
      return l.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\\/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    });

    // Collect ALL commentable elements in document order
    const allElements = [];
    container.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,tr').forEach(node => allElements.push(node));
    allElements.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : (pos & Node.DOCUMENT_POSITION_PRECEDING) ? 1 : 0;
    });

    // Hint: expected line number advances as we match, but we always
    // search the full file. The hint just prioritizes nearby lines.
    let hint = 0;

    function searchLines(needle, startFrom, filterFn) {
      // Search forward from hint first, then wrap around
      for (let pass = 0; pass < 2; pass++) {
        const start = pass === 0 ? startFrom : 0;
        const end = pass === 0 ? lines.length : startFrom;
        for (let i = start; i < end; i++) {
          if (usedLines.has(i + 1)) continue;
          if (filterFn && !filterFn(i)) continue;
          if (needle(i)) return i;
        }
      }
      return -1;
    }

    for (const node of allElements) {
      const tag = node.tagName;
      let matched = -1;

      if (tag === 'TR') {
        // Table row: match cell content against pipe-delimited lines
        const cells = [...node.querySelectorAll('td, th')].map(c =>
          c.textContent.trim().toLowerCase().replace(/\s+/g, ' ')
        ).filter(Boolean);
        if (cells.length === 0) continue;

        // Skip separator rows (----, :---:, etc.)
        if (cells.every(c => /^[-:\s]+$/.test(c))) continue;

        const needle = cells[0].substring(0, 25);
        if (needle.length < 2) continue;

        matched = searchLines(
          i => cleanPipeLines[i].includes(needle),
          hint,
          i => lines[i].includes('|')
        );

      } else if (tag === 'PRE') {
        // Code block: match against ``` fence
        const codeText = node.textContent.trim().substring(0, 50).toLowerCase().replace(/\s+/g, ' ');
        matched = searchLines(
          i => {
            if (!lines[i].startsWith('```')) return false;
            // Verify by checking code content
            const content = [];
            for (let j = i + 1; j < lines.length && !lines[j].startsWith('```'); j++) content.push(lines[j]);
            const block = content.join(' ').trim().substring(0, 30).toLowerCase().replace(/\s+/g, ' ');
            return !block || !codeText || codeText.startsWith(block.substring(0, 12)) || block.startsWith(codeText.substring(0, 12));
          },
          hint,
          null
        );

      } else {
        // Heading, paragraph, list item, blockquote
        const domText = node.textContent.trim().substring(0, 60).toLowerCase().replace(/[()]/g, '').replace(/\s+/g, ' ');
        if (!domText || domText.length < 2) continue;

        matched = searchLines(
          i => {
            const cl = cleanLines[i];
            if (cl.length < 2) return false;
            const len = Math.min(20, cl.length, domText.length);
            if (len < 2) return false;
            const a = cl.substring(0, len);
            const b = domText.substring(0, len);
            return a === b || domText.includes(a) || cl.includes(b);
          },
          hint,
          null
        );
      }

      if (matched >= 0) {
        node.setAttribute('data-line', matched + 1);
        node.style.position = 'relative';
        usedLines.add(matched + 1);
        hint = matched + 1;
      }
    }
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
