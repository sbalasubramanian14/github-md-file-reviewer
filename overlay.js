window.MDROverlay = (() => {
  let pr = null;
  let files = null;
  let fileData = null;
  let el = null;
  let comments = [];
  let threadMap = {}; // REST comment id -> { threadId, isResolved }
  let diffView = false; // diff-aware view: show only changed blocks (+ headings for context)

  // Review mode state — comments collected locally, submitted in one batch
  let reviewMode = false;
  let pendingComments = []; // local: { path, position, line, body }
  let mentionUsers = []; // { login, avatar_url }

  function nextDraftId() {
    return `d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // All markdown (file content + comment bodies) passes through DOMPurify —
  // marked does not sanitize, and comment bodies come from other users.
  function sanitizeHtml(html) {
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  }

  function renderMdBody(text) {
    return sanitizeHtml(marked.parse(text || '', { gfm: true, breaks: true }));
  }

  // Parse a unified diff patch into the set of RIGHT-side line numbers GitHub
  // accepts review comments on (added + context lines inside hunks).
  // Returns null when the patch is unavailable (huge diffs) — treated as "unknown, allow all".
  function parseCommentableLines(patch) {
    if (!patch) return null;
    const set = new Set();
    let newLine = 0;
    for (const l of patch.split('\n')) {
      if (l.startsWith('@@')) {
        const m = l.match(/\+(\d+)(?:,(\d+))?/);
        if (m) newLine = parseInt(m[1]);
        continue;
      }
      if (l.startsWith('-') || l.startsWith('\\')) continue;
      set.add(newLine);
      newLine++;
    }
    return set;
  }

  function isLineCommentable(line) {
    if (!fileData || !fileData.commentable) return true;
    return fileData.commentable.has(line);
  }

  // Set of RIGHT-side line numbers that were actually added (the '+' lines),
  // used to highlight/isolate the real changes in diff-aware view.
  function parseAddedLines(patch) {
    if (!patch) return null;
    const set = new Set();
    let newLine = 0;
    for (const l of patch.split('\n')) {
      if (l.startsWith('@@')) {
        const m = l.match(/\+(\d+)(?:,(\d+))?/);
        if (m) newLine = parseInt(m[1]);
        continue;
      }
      if (l.startsWith('\\')) continue;
      if (l.startsWith('-')) continue;      // removed line — not on the RIGHT side
      if (l.startsWith('+')) { set.add(newLine); newLine++; continue; }
      newLine++;                            // context line
    }
    return set;
  }

  function toast(msg, type = 'success') {
    document.querySelectorAll('.mdr-toast').forEach(t => t.remove());
    const t = document.createElement('div');
    t.className = `mdr-toast mdr-toast-${type}`;
    const icon = document.createElement('span');
    icon.textContent = {success:'\u2713',error:'\u2717',info:'\u2139'}[type] || '';
    const text = document.createElement('span');
    text.textContent = msg;
    t.append(icon, text);
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
    el.querySelector('#mdr-download').addEventListener('click', downloadFile);
    setupReviewMode();
    document.addEventListener('keydown', onEsc);

    await loadPR();
  }

  function close() {
    el?.remove(); el = null;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onEsc);
  }

  function onEsc(e) {
    if (e.key !== 'Escape') return;
    const dialog = el?.querySelector('.mdr-submit-dialog');
    if (dialog) { dialog.remove(); return; }
    if (editMode) return; // exit edit mode explicitly via Cancel/Commit
    if (!el?.querySelector('.mdr-inline-form')) close();
  }

  async function getTheme() {
    return new Promise(r => chrome.storage.local.get(['mdr_theme'], d => {
      r(d.mdr_theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    }));
  }

  function downloadFile() {
    if (!fileData?.raw) { toast('No file loaded', 'error'); return; }
    const filename = fileData.filePath.split('/').pop();
    const blob = new Blob([fileData.raw], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast(`Downloaded ${filename}`);
  }

  function toggleTheme() {
    const current = el.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    el.setAttribute('data-theme', next);
    chrome.storage.local.set({ mdr_theme: next });
    renderMermaidDiagrams(); // re-render diagrams with the matching mermaid theme
    const richUI = el.querySelector('#mdr-editor-rich .toastui-editor-defaultUI');
    if (richUI) richUI.classList.toggle('toastui-editor-dark', next === 'dark');
    updatePreview();
  }

  function shell() {
    return `
      <div class="mdr-topbar">
        <div class="mdr-topbar-left">
          <div class="mdr-topbar-logo">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="currentColor" opacity="0.15"/><path d="M6 8h12M6 12h8M6 16h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            MD Reviewer
          </div>
          <span class="mdr-topbar-pr" id="mdr-pr-info">Loading...</span>
        </div>
        <div class="mdr-topbar-right">
          <div class="mdr-mode-toggle" id="mdr-mode-toggle">
            <button class="mdr-mode-btn active" data-mode="comment">Comment</button>
            <button class="mdr-mode-btn" data-mode="review">Start Review</button>
            <button class="mdr-mode-btn" data-mode="edit">Edit</button>
          </div>
          <span class="mdr-topbar-file" id="mdr-current-file" title=""></span>
          <button class="mdr-download-btn" id="mdr-download" title="Download .md file"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z"/></svg></button>
          <button class="mdr-theme-btn" id="mdr-theme-toggle" title="Toggle dark/light mode"><span class="mdr-theme-sun"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 1.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11ZM8 0a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0V.75A.75.75 0 0 1 8 0Zm0 13a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 8 13ZM2.343 2.343a.75.75 0 0 1 1.061 0l1.06 1.061a.75.75 0 0 1-1.06 1.06L2.343 3.404a.75.75 0 0 1 0-1.06Zm9.193 9.193a.75.75 0 0 1 1.06 0l1.061 1.06a.75.75 0 0 1-1.06 1.061l-1.061-1.06a.75.75 0 0 1 0-1.061ZM0 8a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 8Zm13 0a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 0 1.5h-1.5A.75.75 0 0 1 13 8ZM2.343 13.657a.75.75 0 0 1 0-1.06l1.06-1.061a.75.75 0 0 1 1.061 1.06l-1.06 1.061a.75.75 0 0 1-1.061 0Zm9.193-9.193a.75.75 0 0 1 0-1.06l1.061-1.061a.75.75 0 0 1 1.06 1.06l-1.06 1.061a.75.75 0 0 1-1.061 0Z"/></svg></span><span class="mdr-theme-knob"></span><span class="mdr-theme-moon"><svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.598 1.591a.749.749 0 0 1 .785-.175 7.001 7.001 0 1 1-8.967 8.967.75.75 0 0 1 .961-.96 5.5 5.5 0 0 0 7.046-7.046.75.75 0 0 1 .175-.786Zm1.616 1.945a7 7 0 0 1-7.678 7.678 5.499 5.499 0 1 0 7.678-7.678Z"/></svg></span></button>
          <button class="mdr-close-btn" id="mdr-close" title="Close (Esc)">&times;</button>
        </div>
      </div>
      <div class="mdr-review-bar" id="mdr-review-bar" hidden>
        <span class="mdr-review-bar-text"><span id="mdr-pending-count">0</span> pending comments <span class="mdr-review-warn">— drafts saved locally, persist across refresh</span></span>
        <div class="mdr-review-bar-actions">
          <button class="mdr-rb-btn mdr-rb-discard" id="mdr-review-discard">Discard Review</button>
          <button class="mdr-rb-btn mdr-rb-submit" id="mdr-review-submit">Submit Review</button>
        </div>
      </div>
      <div class="mdr-review-bar" id="mdr-edit-bar" hidden>
        <span class="mdr-review-bar-text">Editing <strong id="mdr-edit-file"></strong> <span class="mdr-review-warn" id="mdr-edit-status">— no changes yet</span></span>
        <div class="mdr-review-bar-actions">
          <div class="mdr-mode-toggle mdr-editview-toggle">
            <button class="mdr-mode-btn active" data-editview="raw" title="Edit raw markdown with live preview">Raw</button>
            <button class="mdr-mode-btn" data-editview="rich" title="Edit visually (WYSIWYG)">Rich</button>
          </div>
          <button class="mdr-rb-btn mdr-rb-discard" id="mdr-edit-cancel">Cancel</button>
          <button class="mdr-rb-btn mdr-rb-submit" id="mdr-edit-commit">Commit changes</button>
        </div>
      </div>
      <div class="mdr-statsbar" id="mdr-statsbar"><span>Loading...</span></div>
      <div class="mdr-body">
        <div class="mdr-filetree" id="mdr-filetree">
          <div class="mdr-filetree-header">
            <span class="mdr-filetree-title">Files <span class="mdr-filetree-count" id="mdr-filetree-count"></span></span>
            <button class="mdr-filetree-collapse" id="mdr-filetree-collapse" title="Hide file tree">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.749.749 0 1 1 1.06 1.06L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z"/></svg>
            </button>
          </div>
          <div class="mdr-filetree-list" id="mdr-filetree-list"></div>
        </div>
        <button class="mdr-filetree-rail" id="mdr-filetree-rail" hidden title="Show file tree">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1h5.5c.966 0 1.75.784 1.75 1.75v1h4a1.75 1.75 0 0 1 1.75 1.75v7.75A1.75 1.75 0 0 1 13 15H3a2 2 0 0 1-2-2V2.75C1 1.784 1.784 1 1.75 1ZM2.5 2.75v10.25c0 .138.112.25.25.25h.25v-8.5a1.75 1.75 0 0 1 1.75-1.75h2.75v-.25a.25.25 0 0 0-.25-.25h-5.5a.25.25 0 0 0-.25.25Z"/></svg>
        </button>
        <div class="mdr-content" id="mdr-content">
          <div class="mdr-loading"><div class="mdr-spinner"></div><span>Loading...</span></div>
        </div>
        <div class="mdr-sidebar" id="mdr-sidebar">
          <div class="mdr-sidebar-header">Comments</div>
          <div class="mdr-sidebar-list" id="mdr-sidebar-list"><span class="mdr-sidebar-empty">No comments yet</span></div>
        </div>
      </div>`;
  }

  function setupReviewMode() {
    el.querySelectorAll('#mdr-mode-toggle .mdr-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode');
        if (!mode) return; // edit-view (Raw/Rich) buttons share the class but not this handler
        el.querySelectorAll('#mdr-mode-toggle .mdr-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (mode === 'review') {
          exitEditMode();
          startReviewMode();
        } else if (mode === 'edit') {
          exitReviewMode();
          startEditMode();
        } else {
          exitEditMode();
          exitReviewMode();
        }
      });
    });

    el.querySelector('#mdr-review-discard').addEventListener('click', discardReview);
    el.querySelector('#mdr-review-submit').addEventListener('click', showSubmitDialog);
    el.querySelector('#mdr-edit-cancel').addEventListener('click', cancelEdit);
    el.querySelector('#mdr-edit-commit').addEventListener('click', showCommitDialog);
    el.querySelectorAll('[data-editview]').forEach(btn =>
      btn.addEventListener('click', () => setEditView(btn.getAttribute('data-editview'))));
  }

  async function startReviewMode() {
    reviewMode = true;
    pendingComments = await loadPendingFromStorage();
    el.querySelector('#mdr-review-bar').hidden = false;
    updatePendingCount();
    if (fileData) { renderCommentsSidebar(fileData.filePath); refreshPendingBadges(); }
    toast('Review mode — add comments, then submit all at once', 'info');
  }

  function exitReviewMode() {
    reviewMode = false;
    pendingComments = [];
    el.querySelector('#mdr-review-bar').hidden = true;
  }

  async function discardReview() {
    if (pendingComments.length > 0 && !confirm(`Discard ${pendingComments.length} pending comment(s)?`)) return;
    exitReviewMode();
    savePendingToStorage();
    el.querySelectorAll('#mdr-mode-toggle .mdr-mode-btn').forEach(b => b.classList.remove('active'));
    el.querySelector('[data-mode="comment"]').classList.add('active');
    el.querySelectorAll('.mdr-pending-badge').forEach(b => b.remove());
    if (fileData) renderCommentsSidebar(fileData.filePath);
    toast('Review discarded');
  }

  function updatePendingCount() {
    const countEl = el.querySelector('#mdr-pending-count');
    if (countEl) countEl.textContent = pendingComments.length;
  }

  function addPendingBadge(block, line) {
    if (block.querySelector('.mdr-pending-badge')) return;
    const badge = document.createElement('span');
    badge.className = 'mdr-pending-badge';
    badge.textContent = 'Pending';
    badge.style.cursor = 'pointer';
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const group = el.querySelector(`.mdr-pending-section .mdr-line-group[data-group-line="${line}"]`);
      if (group) {
        group.scrollIntoView({ behavior: 'smooth', block: 'start' });
        group.classList.add('mdr-flash');
        setTimeout(() => group.classList.remove('mdr-flash'), 1500);
      }
    });
    block.appendChild(badge);
  }

  function refreshPendingBadges() {
    if (!el || !fileData) return;
    el.querySelectorAll('.mdr-markdown .mdr-pending-badge').forEach(b => b.remove());
    pendingComments.filter(c => c.path === fileData.filePath).forEach(c => {
      const target = el.querySelector(`.mdr-markdown [data-line="${c.line}"]`);
      if (target) addPendingBadge(target, c.line);
    });
  }

  // --- Persistence: store pending comments in chrome.storage.local ---

  function getStorageKey() {
    return `mdr_pending_${pr.owner}_${pr.repo}_${pr.pullNumber}`;
  }

  function savePendingToStorage() {
    const key = getStorageKey();
    if (pendingComments.length === 0) {
      chrome.storage.local.remove([key]);
    } else {
      chrome.storage.local.set({ [key]: pendingComments });
    }
  }

  async function loadPendingFromStorage() {
    const key = getStorageKey();
    return new Promise(r => {
      chrome.storage.local.get([key], d => {
        // Drafts saved by older versions have no id — assign one on load
        r((d[key] || []).map(c => c.id ? c : { ...c, id: nextDraftId() }));
      });
    });
  }

  // --- Edit mode: modify the file and commit to the PR branch ---

  let editMode = false;
  let editorDirty = false;
  let previewGen = 0;
  let richEditor = null;
  let editView = 'raw';

  function teardownRichEditor() {
    if (richEditor) {
      try { richEditor.destroy(); } catch {}
      richEditor = null;
    }
  }

  function syncFromRichEditor() {
    const ta = el?.querySelector('#mdr-editor-ta');
    if (!richEditor || !ta) return;
    const md = richEditor.getMarkdown();
    if (md !== ta.value) {
      ta.value = md;
      ta.dispatchEvent(new Event('input'));
    }
  }

  function setEditView(view) {
    const raw = el.querySelector('#mdr-editor-raw');
    const rich = el.querySelector('#mdr-editor-rich');
    const ta = el.querySelector('#mdr-editor-ta');
    if (!raw || !rich || !ta) return;

    if (view === 'rich' && !window.toastui?.Editor) {
      toast('Rich editor failed to load — using raw view', 'error');
      view = 'raw';
    }

    el.querySelectorAll('[data-editview]').forEach(b =>
      b.classList.toggle('active', b.getAttribute('data-editview') === view));

    if (view === 'rich') {
      raw.hidden = true;
      rich.hidden = false;
      if (!richEditor) {
        richEditor = new toastui.Editor({
          el: rich,
          initialEditType: 'wysiwyg',
          hideModeSwitch: true,
          height: '100%',
          initialValue: ta.value,
          usageStatistics: false,
          autofocus: true,
          theme: el.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
        });
        let debounce;
        richEditor.on('change', () => {
          clearTimeout(debounce);
          debounce = setTimeout(syncFromRichEditor, 300);
        });
      } else if (richEditor.getMarkdown() !== ta.value) {
        richEditor.setMarkdown(ta.value);
      }
    } else {
      if (richEditor && !rich.hidden) syncFromRichEditor();
      rich.hidden = true;
      raw.hidden = false;
    }

    editView = view;
    chrome.storage.local.set({ mdr_edit_view: view });
  }

  function editStorageKey() {
    return `mdr_edit_${pr.owner}_${pr.repo}_${pr.pullNumber}_${fileData.filePath}`;
  }

  function toBase64Utf8(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  function updateEditStatus() {
    const status = el.querySelector('#mdr-edit-status');
    if (status) status.textContent = editorDirty ? '— unsaved changes (kept locally until you commit)' : '— no changes yet';
  }

  async function startEditMode() {
    if (!fileData) { toast('File still loading', 'info'); return; }
    editMode = true;
    editorDirty = false;
    el.querySelector('#mdr-edit-bar').hidden = false;
    el.querySelector('#mdr-edit-file').textContent = fileData.filePath;

    const content = el.querySelector('#mdr-content');
    content.classList.add('mdr-content-editing');
    content.innerHTML = `
      <div class="mdr-editor">
        <div class="mdr-editor-raw" id="mdr-editor-raw">
          <textarea class="mdr-editor-textarea" id="mdr-editor-ta" spellcheck="false"></textarea>
          <div class="mdr-editor-preview mdr-markdown" id="mdr-editor-preview"></div>
        </div>
        <div class="mdr-editor-rich" id="mdr-editor-rich" hidden></div>
      </div>`;

    const ta = el.querySelector('#mdr-editor-ta');
    ta.value = fileData.raw;

    // Restore unsaved edits from a previous session
    const key = editStorageKey();
    const saved = await new Promise(r => chrome.storage.local.get([key], d => r(d[key])));
    if (typeof saved === 'string' && saved !== fileData.raw) {
      ta.value = saved;
      editorDirty = true;
      toast('Restored unsaved edits', 'info');
    }
    updateEditStatus();
    updatePreview();

    let debounce;
    ta.addEventListener('input', () => {
      editorDirty = ta.value !== fileData.raw;
      updateEditStatus();
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (editorDirty) chrome.storage.local.set({ [key]: ta.value });
        else chrome.storage.local.remove([key]);
        updatePreview();
      }, 300);
    });

    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart, epos = ta.selectionEnd;
        ta.setRangeText('  ', s, epos, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    });
    setTimeout(() => ta.focus(), 50);

    // Restore the user's preferred editor view (raw or rich)
    editView = 'raw';
    chrome.storage.local.get(['mdr_edit_view'], d => {
      if (d.mdr_edit_view === 'rich' && editMode) setEditView('rich');
    });
  }

  async function updatePreview() {
    const ta = el?.querySelector('#mdr-editor-ta');
    const prev = el?.querySelector('#mdr-editor-preview');
    if (!ta || !prev) return;
    const gen = ++previewGen;
    prev.innerHTML = sanitizeHtml(marked.parse(ta.value, { gfm: true, breaks: false }));
    if (!window.mermaid) return;
    const dark = el.getAttribute('data-theme') === 'dark';
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
    for (const codeEl of prev.querySelectorAll('pre > code.language-mermaid')) {
      const id = `mdr-preview-mermaid-${++mermaidSeq}`;
      try {
        const { svg } = await mermaid.render(id, codeEl.textContent.replace(/\n$/, ''));
        if (gen !== previewGen) return; // a newer preview replaced this one
        const div = document.createElement('div');
        div.className = 'mdr-mermaid-diagram';
        div.innerHTML = svg;
        codeEl.closest('pre').replaceWith(div);
      } catch {
        document.getElementById(`d${id}`)?.remove(); // leave the code block as-is
      }
    }
  }

  function exitEditMode() {
    if (!editMode) return;
    editMode = false;
    editorDirty = false;
    teardownRichEditor();
    el.querySelector('#mdr-edit-bar').hidden = true;
    el.querySelector('#mdr-content').classList.remove('mdr-content-editing');
    if (fileData) loadFile(fileData.filePath);
  }

  function cancelEdit() {
    if (editorDirty && !confirm('Discard your unsaved edits?')) return;
    chrome.storage.local.remove([editStorageKey()]);
    exitEditMode();
    el.querySelectorAll('#mdr-mode-toggle .mdr-mode-btn').forEach(b => b.classList.remove('active'));
    el.querySelector('[data-mode="comment"]').classList.add('active');
  }

  function showCommitDialog() {
    const ta = el.querySelector('#mdr-editor-ta');
    if (!ta) return;
    if (editView === 'rich') syncFromRichEditor(); // pick up anything inside the debounce window
    if (!editorDirty) { toast('No changes to commit', 'info'); return; }

    el.querySelectorAll('.mdr-submit-dialog').forEach(d => d.remove());
    const filename = fileData.filePath.split('/').pop();
    const dialog = document.createElement('div');
    dialog.className = 'mdr-submit-dialog';
    dialog.innerHTML = `
      <div class="mdr-submit-dialog-inner">
        <div class="mdr-submit-dialog-header">Commit changes to <code></code></div>
        <textarea class="mdr-inline-textarea" id="mdr-commit-msg" rows="2"></textarea>
        <div class="mdr-submit-dialog-note">Commits directly to <strong id="mdr-commit-branch"></strong> — the PR updates immediately.</div>
        <div class="mdr-submit-dialog-actions">
          <button class="mdr-rb-btn mdr-rb-discard" id="mdr-cd-cancel">Cancel</button>
          <button class="mdr-rb-btn mdr-rb-submit" id="mdr-cd-commit">Commit</button>
        </div>
      </div>`;
    dialog.querySelector('code').textContent = fileData.filePath;
    dialog.querySelector('#mdr-commit-msg').value = `docs: update ${filename}`;
    dialog.querySelector('#mdr-commit-branch').textContent = `${pr.headRepo || pr.owner + '/' + pr.repo}@${pr.headRef}`;

    el.appendChild(dialog);
    dialog.querySelector('#mdr-cd-cancel').addEventListener('click', () => dialog.remove());
    dialog.querySelector('#mdr-cd-commit').addEventListener('click', async () => {
      const message = dialog.querySelector('#mdr-commit-msg').value.trim() || `docs: update ${filename}`;
      const btn = dialog.querySelector('#mdr-cd-commit');
      btn.disabled = true;
      btn.textContent = 'Committing...';
      try {
        await commitEdit(message);
        dialog.remove();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Commit';
        const msg = /409|does not match/.test(err.message)
          ? 'File changed on the branch since you loaded it — reopen the overlay and re-apply your edits'
          : err.message;
        toast(msg, 'error');
      }
    });
  }

  async function commitEdit(message) {
    const ta = el.querySelector('#mdr-editor-ta');
    const headFull = pr.headRepo || `${pr.owner}/${pr.repo}`;
    const [headOwner, headRepoName] = headFull.split('/');

    // Current blob sha from the head branch — required by the contents API,
    // and its freshness is what detects mid-air collisions (409/422).
    const meta = await GitHubAPI.getFileMeta(headOwner, headRepoName, fileData.filePath, pr.headRef);
    const resp = await GitHubAPI.putFile(headOwner, headRepoName, fileData.filePath, {
      message,
      content: toBase64Utf8(ta.value),
      sha: meta.sha,
      branch: pr.headRef
    });

    pr.headSha = resp.commit.sha;
    chrome.storage.local.remove([editStorageKey()]);
    editorDirty = false;

    // Diff hunks changed — refresh file list so commentable-line detection stays correct
    try {
      const freshFiles = await GitHubAPI.getPRFiles(pr.owner, pr.repo, pr.pullNumber);
      files = freshFiles.filter(f => /\.(md|markdown|mdx)$/i.test(f.filename) && f.status !== 'removed');
      renderFileTree();
    } catch {}

    exitEditMode();
    el.querySelectorAll('#mdr-mode-toggle .mdr-mode-btn').forEach(b => b.classList.remove('active'));
    el.querySelector('[data-mode="comment"]').classList.add('active');
    toast(`Committed to ${pr.headRef} — PR updated`);
  }

  function showSubmitDialog() {
    if (pendingComments.length === 0) {
      toast('No pending comments to submit', 'error');
      return;
    }

    // Remove existing dialog
    el.querySelectorAll('.mdr-submit-dialog').forEach(d => d.remove());

    const dialog = document.createElement('div');
    dialog.className = 'mdr-submit-dialog';
    dialog.innerHTML = `
      <div class="mdr-submit-dialog-inner">
        <div class="mdr-submit-dialog-header">Submit Review (${pendingComments.length} comments)</div>
        <textarea class="mdr-inline-textarea" id="mdr-review-body" placeholder="Review summary (optional)..."></textarea>
        <div class="mdr-submit-dialog-actions">
          <button class="mdr-rb-btn mdr-rb-discard" id="mdr-sd-cancel">Cancel</button>
          <button class="mdr-rb-btn mdr-sd-approve" data-event="APPROVE">Approve</button>
          <button class="mdr-rb-btn mdr-sd-reqchanges" data-event="REQUEST_CHANGES">Request Changes</button>
          <button class="mdr-rb-btn mdr-rb-submit" data-event="COMMENT">Comment</button>
        </div>
      </div>`;

    el.appendChild(dialog);

    dialog.querySelector('#mdr-sd-cancel').addEventListener('click', () => dialog.remove());

    dialog.querySelectorAll('[data-event]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const event = btn.getAttribute('data-event');
        const body = dialog.querySelector('#mdr-review-body').value.trim();

        dialog.querySelectorAll('button').forEach(b => { b.disabled = true; });
        btn.textContent = 'Submitting...';

        try {
          dialog.remove();
          await submitBatchReview(event, body);
        } catch (err) {
          dialog.querySelectorAll('button').forEach(b => { b.disabled = false; });
          btn.textContent = btn.getAttribute('data-event');
          toast(err.message, 'error');
        }
      });
    });
  }

  async function submitBatchReview(event, body) {
    // Create review with all comments in a single API call
    await GitHubAPI.request(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.pullNumber}/reviews`, {
      method: 'POST',
      body: JSON.stringify({
        commit_id: pr.headSha,
        event,
        body: body || '',
        comments: pendingComments.map(c => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body }))
      })
    });

    const count = pendingComments.length;
    const prevCount = comments.length;

    exitReviewMode();
    savePendingToStorage();
    el.querySelectorAll('#mdr-mode-toggle .mdr-mode-btn').forEach(b => b.classList.remove('active'));
    el.querySelector('[data-mode="comment"]').classList.add('active');
    el.querySelectorAll('.mdr-pending-badge').forEach(b => b.remove());

    toast(`Review submitted (${count} comments) — syncing...`, 'info');

    // Show loader in sidebar while polling
    const list = el.querySelector('#mdr-sidebar-list');
    if (list) list.innerHTML = '<div class="mdr-loading"><div class="mdr-spinner"></div><span>Syncing comments from GitHub...</span></div>';

    // Poll until new comments appear
    const expectedCount = prevCount + count;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      comments = await GitHubAPI.getComments(pr.owner, pr.repo, pr.pullNumber);
      if (comments.length >= expectedCount) break;
      if (list) list.querySelector('span').textContent = `Syncing comments from GitHub... (attempt ${attempt + 2})`;
    }
    await loadThreadMap();

    if (fileData) await loadFile(fileData.filePath);

    toast(`Review synced (${count} comments)`, 'success');
  }

  async function loadPR() {
    try {
      el.querySelector('#mdr-pr-info').textContent = `PR #${pr.pullNumber} · ${pr.owner}/${pr.repo}`;

      // Refresh head info at overlay-open time — the page may have been loaded
      // long ago and new commits pushed since (stale sha breaks comment anchoring).
      try {
        const fresh = await GitHubAPI.getPR(pr.owner, pr.repo, pr.pullNumber);
        pr.headSha = fresh.head.sha;
        pr.headRef = fresh.head.ref;
        pr.headRepo = fresh.head.repo ? fresh.head.repo.full_name : `${pr.owner}/${pr.repo}`;
        pr.prUser = fresh.user;
        pr.requestedReviewers = fresh.requested_reviewers || [];
      } catch {}
      renderFileTree();
      setupFileTreeCollapse();

      comments = await GitHubAPI.getComments(pr.owner, pr.repo, pr.pullNumber);
      await loadThreadMap();

      // Build mention users list from collaborators + commenters
      buildMentionUsers();

      // Restore pending comments from storage
      const saved = await loadPendingFromStorage();
      if (saved.length > 0) {
        pendingComments = saved;
        reviewMode = true;
        el.querySelector('#mdr-review-bar').hidden = false;
        el.querySelectorAll('#mdr-mode-toggle .mdr-mode-btn').forEach(b => b.classList.remove('active'));
        el.querySelector('[data-mode="review"]').classList.add('active');
        updatePendingCount();
        toast(`Restored ${saved.length} pending review comments`, 'info');
      }

      if (files.length > 0) loadFile(files[0].filename);
    } catch (err) {
      setContent(`<div class="mdr-loading"><span class="mdr-error">${err.message}</span></div>`);
    }
  }

  // --- File tree pane ---

  function selectFile(path) {
    if (path === fileData?.filePath) return;
    if (editMode) {
      // Unsaved edits are already persisted per-file; restore offered on return
      editMode = false;
      editorDirty = false;
      teardownRichEditor();
      el.querySelector('#mdr-edit-bar').hidden = true;
      el.querySelector('#mdr-content').classList.remove('mdr-content-editing');
      el.querySelectorAll('#mdr-mode-toggle .mdr-mode-btn').forEach(b => b.classList.remove('active'));
      el.querySelector('[data-mode="comment"]').classList.add('active');
    }
    loadFile(path);
  }

  function renderFileTree() {
    const list = el.querySelector('#mdr-filetree-list');
    if (!list) return;
    el.querySelector('#mdr-filetree-count').textContent = `(${files.length})`;

    // Build nested structure from file paths
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.filename.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { dirs: new Map(), files: [] });
        node = node.dirs.get(parts[i]);
      }
      node.files.push(f);
    }

    list.innerHTML = '';
    list.appendChild(renderTreeLevel(root, 0));
    updateFileTreeActive();
  }

  function renderTreeLevel(node, depth) {
    const ul = document.createElement('ul');
    ul.className = 'mdr-tree-ul';

    for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.className = 'mdr-tree-row mdr-tree-dir';
      row.style.paddingLeft = `${10 + depth * 14}px`;
      row.innerHTML = `
        <span class="mdr-tree-arrow">&#9660;</span>
        <svg class="mdr-tree-ico" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1h5.5c.55 0 1.07.26 1.4.7l.9 1.2c.05.06.12.1.2.1h4.5c.97 0 1.75.78 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.78.78 1 1.75 1Z"/></svg>
        <span class="mdr-tree-name"></span>`;
      row.querySelector('.mdr-tree-name').textContent = name;
      const sub = renderTreeLevel(child, depth + 1);
      row.addEventListener('click', () => {
        sub.hidden = !sub.hidden;
        row.querySelector('.mdr-tree-arrow').innerHTML = sub.hidden ? '&#9654;' : '&#9660;';
      });
      li.append(row, sub);
      ul.appendChild(li);
    }

    for (const f of [...node.files].sort((a, b) => a.filename.localeCompare(b.filename))) {
      const li = document.createElement('li');
      const row = document.createElement('button');
      row.className = 'mdr-tree-row mdr-tree-file';
      row.setAttribute('data-path', f.filename);
      row.title = f.filename;
      row.style.paddingLeft = `${10 + depth * 14 + 16}px`;
      row.innerHTML = `
        <svg class="mdr-tree-ico" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Z"/></svg>
        <span class="mdr-tree-name"></span>
        <span class="mdr-tree-adds"></span>`;
      row.querySelector('.mdr-tree-name').textContent = f.filename.split('/').pop();
      row.querySelector('.mdr-tree-adds').textContent = `+${f.additions}`;
      row.addEventListener('click', () => selectFile(f.filename));
      li.appendChild(row);
      ul.appendChild(li);
    }

    return ul;
  }

  function updateFileTreeActive() {
    el.querySelectorAll('.mdr-tree-file').forEach(n =>
      n.classList.toggle('active', n.getAttribute('data-path') === fileData?.filePath));
    const label = el.querySelector('#mdr-current-file');
    if (label && fileData) {
      label.textContent = fileData.filePath.split('/').pop();
      label.title = fileData.filePath;
    }
  }

  function setupFileTreeCollapse() {
    const pane = el.querySelector('#mdr-filetree');
    const rail = el.querySelector('#mdr-filetree-rail');
    const setCollapsed = (collapsed) => {
      pane.hidden = collapsed;
      rail.hidden = !collapsed;
      chrome.storage.local.set({ mdr_tree_collapsed: collapsed });
    };
    el.querySelector('#mdr-filetree-collapse').addEventListener('click', () => setCollapsed(true));
    rail.addEventListener('click', () => setCollapsed(false));
    chrome.storage.local.get(['mdr_tree_collapsed'], d => { if (d.mdr_tree_collapsed) setCollapsed(true); });
  }

  async function loadFile(filePath) {
    setContent('<div class="mdr-loading"><div class="mdr-spinner"></div><span>Rendering...</span></div>');
    try {
      // Fetch by head sha, not branch name — a fork PR's branch doesn't exist
      // in the base repo, but its head commits are reachable there by sha.
      const raw = await GitHubAPI.getRawFile(pr.owner, pr.repo, filePath, pr.headSha);
      const html = renderWithLines(raw);

      const file = files.find(f => f.filename === filePath);
      const isModified = file && file.status !== 'added';
      fileData = {
        filePath, raw,
        commentable: parseCommentableLines(file?.patch),
        added: parseAddedLines(file?.patch),
        isModified
      };
      setContent(`<div class="mdr-markdown">${html}</div>`);

      const blocks = [...el.querySelectorAll('[data-line]')];
      const blockCount = blocks.length;
      const commentableCount = blocks.filter(b => isLineCommentable(parseInt(b.getAttribute('data-line')))).length;

      markChangedBlocks();
      // Default to diff-aware view on modified files (where there's unchanged
      // content to hide); pure-new files show in full.
      diffView = !!(isModified && fileData.added && fileData.added.size);

      const commentableNote = commentableCount === blockCount
        ? `<span>All commentable</span>`
        : `<span>${commentableCount}/${blockCount} commentable — GitHub only allows comments on lines in the diff</span>`;
      const diffToggle = isModified
        ? `<button class="mdr-diff-toggle" id="mdr-diff-toggle"></button>`
        : '';
      el.querySelector('#mdr-statsbar').innerHTML =
        `<span>${blockCount} blocks</span><span>+${file.additions} lines</span>${commentableNote}${diffToggle}`;

      if (isModified) {
        const btn = el.querySelector('#mdr-diff-toggle');
        btn.addEventListener('click', () => { diffView = !diffView; applyDiffView(); });
      }
      applyDiffView();

      renderCommentsSidebar(filePath);
      attachCommentButtons();
      refreshPendingBadges();
      renderMermaidDiagrams();
      updateFileTreeActive();
    } catch (err) {
      setContent(`<div class="mdr-loading"><span class="mdr-error">${err.message}</span></div>`);
    }
  }

  // --- Diff-aware view ---

  // Block units the diff view reasons about. Operating at unit granularity (not
  // per line) means a code block's <pre> shell is shown/hidden as a whole rather
  // than left as an empty box when its individual lines are hidden.
  const DIFF_UNIT_SEL = 'h1,h2,h3,h4,h5,h6,p,blockquote,pre,tr,li,.mdr-mermaid-block';

  // Tag each block unit as changed (contains an added line) and/or context
  // (headings + table header rows, always shown to keep structure readable).
  function markChangedBlocks() {
    const added = fileData?.added;
    el.querySelectorAll(`.mdr-markdown :is(${DIFF_UNIT_SEL})`).forEach(b => {
      const own = parseInt(b.getAttribute('data-line'));
      const isContext = /^H[1-6]$/.test(b.tagName) || (b.tagName === 'TR' && !!b.querySelector('th'));
      let changed;
      if (!added) {
        changed = true;
      } else {
        // Changed if this unit's own line, or any descendant line, was added.
        const lines = [];
        if (!isNaN(own)) lines.push(own);
        b.querySelectorAll('[data-line]').forEach(n => lines.push(parseInt(n.getAttribute('data-line'))));
        changed = lines.some(l => added.has(l));
      }
      b.toggleAttribute('data-changed', changed);
      b.toggleAttribute('data-context', isContext);
    });
  }

  function applyDiffView() {
    const md = el.querySelector('.mdr-markdown');
    if (!md) return;
    md.querySelectorAll(`:is(${DIFF_UNIT_SEL})`).forEach(b => {
      const hide = diffView && !b.hasAttribute('data-changed') && !b.hasAttribute('data-context');
      b.classList.toggle('mdr-diff-hide', hide);
    });
    md.classList.toggle('mdr-diff-only', diffView);
    const btn = el.querySelector('#mdr-diff-toggle');
    if (btn) {
      btn.textContent = diffView ? 'Showing changes · Show full document' : 'Show changed only';
      btn.classList.toggle('mdr-diff-toggle-active', diffView);
    }
  }

  // --- Line mapping ---

  function renderWithLines(raw) {
    const html = sanitizeHtml(marked.parse(raw, { gfm: true, breaks: false }));
    const container = document.createElement('div');
    container.innerHTML = html;

    assignAllLines(container, raw);
    splitCodeBlockLines(container);

    return container.innerHTML;
  }

  function splitCodeBlockLines(container) {
    container.querySelectorAll('pre[data-line]').forEach(pre => {
      const fenceLine = parseInt(pre.getAttribute('data-line'));
      const codeEl = pre.querySelector('code');
      const text = codeEl ? codeEl.textContent : pre.textContent;
      const src = text.replace(/\n$/, '');
      const codeLines = src.split('\n');

      // Build line-by-line HTML inside the pre
      // Each line is a div with its own data-line (fence line + 1 + index)
      const linesHtml = codeLines.map((line, i) => {
        const lineNum = fenceLine + 1 + i; // +1 to skip the ``` fence itself
        const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<div class="mdr-code-line" data-line="${lineNum}" style="position:relative"><span class="mdr-code-linenum">${lineNum}</span><span class="mdr-code-text">${escaped || ' '}</span></div>`;
      }).join('');

      // Mermaid blocks render as a diagram with a source toggle. The wrapper
      // carries the fence's data-line so the diagram is commentable as a block;
      // the source view keeps per-line commenting.
      if (codeEl && /\blanguage-mermaid\b/.test(codeEl.className) && window.mermaid) {
        const wrapper = document.createElement('div');
        wrapper.className = 'mdr-mermaid-block';
        wrapper.setAttribute('data-line', fenceLine);
        wrapper.setAttribute('style', 'position:relative');
        wrapper.innerHTML = `
          <div class="mdr-mermaid-toolbar"><span>mermaid</span><button class="mdr-mermaid-toggle" type="button">View source</button></div>
          <div class="mdr-mermaid-diagram" data-mermaid-src="${encodeURIComponent(src)}"><div class="mdr-loading"><div class="mdr-spinner"></div></div></div>
          <pre class="mdr-mermaid-source" style="padding:0;margin:0" hidden>${linesHtml}</pre>`;
        pre.replaceWith(wrapper);
        return;
      }

      pre.innerHTML = linesHtml;
      pre.removeAttribute('data-line'); // remove block-level data-line; individual lines have it
      pre.style.position = '';
      pre.style.padding = '0';
    });
  }

  // --- Mermaid rendering ---

  let mermaidSeq = 0;

  async function renderMermaidDiagrams() {
    if (!window.mermaid || !el) return;
    const dark = el.getAttribute('data-theme') === 'dark';
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });

    for (const target of el.querySelectorAll('.mdr-mermaid-diagram')) {
      const src = decodeURIComponent(target.getAttribute('data-mermaid-src') || '');
      if (!src) continue;
      const id = `mdr-mermaid-${++mermaidSeq}`;
      try {
        const { svg } = await mermaid.render(id, src);
        target.innerHTML = svg;
      } catch (err) {
        // Mermaid leaves a temp error element in the body on failure
        document.getElementById(`d${id}`)?.remove();
        target.innerHTML = '';
        const errEl = document.createElement('div');
        errEl.className = 'mdr-mermaid-error';
        errEl.textContent = `Mermaid render failed: ${err?.message || err}`;
        target.appendChild(errEl);
        const srcEl = target.closest('.mdr-mermaid-block')?.querySelector('.mdr-mermaid-source');
        if (srcEl) srcEl.hidden = false;
      }
    }

    el.querySelectorAll('.mdr-mermaid-toggle').forEach(btn => {
      if (btn.__mdrBound) return;
      btn.__mdrBound = true;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const block = btn.closest('.mdr-mermaid-block');
        const dia = block.querySelector('.mdr-mermaid-diagram');
        const srcEl = block.querySelector('.mdr-mermaid-source');
        const showSrc = srcEl.hidden;
        srcEl.hidden = !showSrc;
        dia.hidden = showSrc;
        btn.textContent = showSrc ? 'View diagram' : 'View source';
      });
    });
  }

  function stripMarkdown(text) {
    return text
      .replace(/^#{1,6}\s+/, '')       // heading prefix
      .replace(/^\s*>+\s*/, '')        // blockquote marker(s) (before emphasis, so **bold** at start survives)
      .replace(/^[\s*+\-\d.]+/, '')    // list marker prefix (leading only)
      .replace(/\*\*(.+?)\*\*/g, '$1') // bold
      .replace(/\*(.+?)\*/g, '$1')     // italic
      .replace(/__(.+?)__/g, '$1')     // bold
      .replace(/_(.+?)_/g, '$1')       // italic
      .replace(/`([^`]+)`/g, '$1')     // inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
      .replace(/[*()]/g, '')           // stray emphasis/parens left over
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

    // Pre-compute opening fence line numbers (skip closing fences)
    const openingFences = [];
    let inCode = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('```')) {
        if (!inCode) openingFences.push(i);
        inCode = !inCode;
      }
    }
    let nextFenceIdx = 0;

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

        // Use multiple cells for matching — single-char cells like "1" are ambiguous
        // Find the longest/most-specific cell to use as primary needle
        const needles = cells
          .map(c => c.substring(0, 25))
          .filter(c => c.length >= 2)
          .sort((a, b) => b.length - a.length);

        if (needles.length === 0) continue;

        matched = searchLines(
          i => {
            const pl = cleanPipeLines[i];
            // Must match the longest needle, plus at least one more if available
            if (!pl.includes(needles[0])) return false;
            if (needles.length > 1 && !pl.includes(needles[1])) return false;
            return true;
          },
          hint,
          i => lines[i].includes('|')
        );

      } else if (tag === 'PRE') {
        // Code block: match to the next opening ``` fence
        if (nextFenceIdx < openingFences.length) {
          const fenceLine = openingFences[nextFenceIdx];
          if (!usedLines.has(fenceLine + 1)) {
            matched = fenceLine;
            nextFenceIdx++;
          }
        }

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

  async function loadThreadMap() {
    try {
      threadMap = await GitHubAPI.getReviewThreads(pr.owner, pr.repo, pr.pullNumber);
    } catch (err) {
      threadMap = {}; // GraphQL may be unavailable (e.g. token without scope) — degrade gracefully
    }
  }

  function threadFor(rootId) {
    return threadMap[rootId] || null;
  }

  async function toggleResolve(rootId, resolve) {
    const t = threadFor(rootId);
    if (!t) { toast('No thread found for this comment', 'error'); return; }
    try {
      if (resolve) await GitHubAPI.resolveThread(t.threadId);
      else await GitHubAPI.unresolveThread(t.threadId);
      t.isResolved = resolve;
      renderCommentsSidebar(fileData.filePath);
      toast(resolve ? 'Thread resolved' : 'Thread reopened');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function renderCommentsSidebar(filePath) {
    const fileComments = comments.filter(c => c.path === filePath);
    const filePending = pendingComments.filter(c => c.path === filePath);
    const list = el.querySelector('#mdr-sidebar-list');
    const currentUser = await getCurrentUser();

    const totalCount = fileComments.length + filePending.length;
    el.querySelector('.mdr-sidebar-header').textContent =
      `Comments (${fileComments.length})${filePending.length ? ` + ${filePending.length} pending` : ''}`;

    highlightCommentedLines(filePath);

    if (totalCount === 0) {
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

    // Render pending (draft) comments first
    if (filePending.length > 0) {
      const pendingByLine = new Map();
      filePending.forEach(c => {
        const arr = pendingByLine.get(c.line) || [];
        arr.push(c);
        pendingByLine.set(c.line, arr);
      });
      const pendingLines = [...pendingByLine.keys()].sort((a, b) => a - b);

      html += `<div class="mdr-pending-section">`;
      html += `<div class="mdr-pending-section-header">Pending Review (${filePending.length})</div>`;
      for (const line of pendingLines) {
        html += `<div class="mdr-line-group" data-group-line="${line}">`;
        html += `<div class="mdr-line-group-header" data-line="${line}">Line ${line}</div>`;
        for (const c of pendingByLine.get(line)) {
          html += `
            <div class="mdr-comment-card mdr-pending-card" data-pending-id="${c.id}" data-line="${c.line}">
              <div class="mdr-comment-meta">
                <span class="mdr-pending-badge">Draft</span>
                <span class="mdr-comment-line">L${c.line}</span>
              </div>
              <div class="mdr-comment-body mdr-comment-md">${renderMdBody(c.body)}</div>
              <div class="mdr-comment-actions">
                <button class="mdr-ca-btn mdr-ca-delete mdr-pending-remove" data-pending-id="${c.id}">Remove</button>
              </div>
            </div>`;
        }
        html += `</div>`;
      }
      html += `</div>`;
    }

    for (const line of sortedLines) {
      const group = lineGroups.get(line);
      group.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      html += `<div class="mdr-line-group" data-group-line="${line}">`;
      html += `<div class="mdr-line-group-header" data-line="${line}">Line ${line}</div>`;

      for (const root of group) {
        const replies = (replyMap.get(root.id) || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const hasReplies = replies.length > 0;
        const thread = threadFor(root.id);
        const resolved = thread?.isResolved;

        html += `<div class="mdr-thread ${resolved ? 'mdr-thread-resolved' : ''}" data-root="${root.id}">`;

        if (resolved) {
          html += `<div class="mdr-thread-resolved-bar" data-expand="${root.id}">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L1.72 8.78a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>
            Resolved · ${root.user.login} <span class="mdr-thread-show">Show</span>
          </div>`;
        }

        html += `<div class="mdr-thread-inner" ${resolved ? 'hidden' : ''}>`;
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

        html += `<div class="mdr-thread-actions">
          <button class="mdr-ca-btn mdr-ca-reply" data-reply-to="${root.id}" data-line="${getCommentLine(root)}">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M6.78 1.97a.75.75 0 0 1 0 1.06L3.81 6h6.44A4.75 4.75 0 0 1 15 10.75v2.5a.75.75 0 0 1-1.5 0v-2.5a3.25 3.25 0 0 0-3.25-3.25H3.81l2.97 2.97a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L1.47 7.28a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Z"/></svg>
            Reply
          </button>`;
        if (thread) {
          html += `<button class="mdr-ca-btn mdr-ca-resolve" data-root="${root.id}" data-resolve="${resolved ? 'false' : 'true'}">
            ${resolved ? 'Reopen' : 'Resolve'}
          </button>`;
        }
        html += `</div>`;
        html += `</div>`; // .mdr-thread-inner
        html += `</div>`; // .mdr-thread
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

    // Resolve / reopen thread
    list.querySelectorAll('.mdr-ca-resolve').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleResolve(parseInt(btn.getAttribute('data-root')), btn.getAttribute('data-resolve') === 'true');
      });
    });

    // Expand a collapsed resolved thread in place
    list.querySelectorAll('.mdr-thread-resolved-bar').forEach(bar => {
      bar.addEventListener('click', (e) => {
        e.stopPropagation();
        const inner = bar.nextElementSibling;
        const show = inner.hidden;
        inner.hidden = !show;
        bar.querySelector('.mdr-thread-show').textContent = show ? 'Hide' : 'Show';
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

    // Pending comment remove buttons
    list.querySelectorAll('.mdr-pending-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = btn.getAttribute('data-pending-id');
        const idx = pendingComments.findIndex(c => c.id === id);
        if (idx === -1) return;
        pendingComments.splice(idx, 1);
        updatePendingCount();
        savePendingToStorage();
        refreshPendingBadges();
        renderCommentsSidebar(filePath);
        toast('Draft comment removed');
      });
    });

    // Pending cards click to scroll
    list.querySelectorAll('.mdr-pending-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.mdr-ca-btn')) return;
        scrollToLine(card.getAttribute('data-line'));
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
        <div class="mdr-comment-body mdr-comment-md" id="mdr-cbody-${c.id}">${renderMdBody(c.body)}</div>
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
    attachMentionAutocomplete(ta);
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
      const line = parseInt(block.getAttribute('data-line'));
      const commentable = isLineCommentable(line);
      const btn = document.createElement('button');
      btn.className = 'mdr-comment-btn' + (commentable ? '' : ' mdr-comment-btn-disabled');
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2v2.19l2.72-2.72.53-.22h4.25a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75z"/></svg>`;
      btn.title = commentable
        ? `Comment on line ${line}`
        : `Line ${line} is not part of the PR diff — GitHub only allows review comments on changed or nearby lines`;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (!commentable) {
          toast('This line is not in the PR diff — GitHub only allows comments on changed lines', 'info');
          return;
        }
        openForm(block);
      });
      block.appendChild(btn);
    });
  }

  function openForm(block) {
    el.querySelectorAll('.mdr-inline-form').forEach(f => f.remove());
    const line = parseInt(block.getAttribute('data-line'));
    const isReview = reviewMode;
    const submitLabel = isReview ? 'Add to Review' : 'Submit';

    const form = document.createElement('div');
    form.className = 'mdr-inline-form';
    form.innerHTML = `
      <div class="mdr-inline-header">Line ${line} ${isReview ? '<span class="mdr-review-badge">Review Mode</span>' : ''}</div>
      <textarea class="mdr-inline-textarea" placeholder="${isReview ? 'Add comment to review...' : 'Leave a comment...'}" autofocus></textarea>
      <div class="mdr-inline-actions">
        <button class="mdr-btn-cancel">Cancel</button>
        <button class="mdr-btn-submit">${submitLabel}</button>
      </div>`;

    // Insert form right after the clicked element
    // For code lines inside <pre>, insert inline so it stays near the line
    if (block.closest('pre')) {
      form.classList.add('mdr-inline-form-code');
    }
    block.after(form);
    const ta = form.querySelector('textarea');
    const sub = form.querySelector('.mdr-btn-submit');
    attachMentionAutocomplete(ta);
    setTimeout(() => ta.focus(), 50);

    form.querySelector('.mdr-btn-cancel').addEventListener('click', () => form.remove());
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sub.click();
      if (e.key === 'Escape') form.remove();
    });

    sub.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text) { ta.style.borderColor = '#ef4444'; return; }

      if (isReview) {
        // Batch mode: collect locally, submit all at once later
        pendingComments.push({ id: nextDraftId(), path: fileData.filePath, line, body: text });
        updatePendingCount();
        form.remove();

        addPendingBadge(block, line);
        savePendingToStorage();

        renderCommentsSidebar(fileData.filePath);
        toast(`Comment added to review (${pendingComments.length} pending)`, 'info');
        return;
      }

      // Immediate mode: post now
      sub.disabled = true; sub.textContent = 'Posting...';
      try {
        const newComment = await GitHubAPI.postComment(pr.owner, pr.repo, pr.pullNumber, {
          body: text, commitId: pr.headSha, path: fileData.filePath, line
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

  // --- @ mention autocomplete ---

  async function buildMentionUsers() {
    const seen = new Set();
    mentionUsers = [];

    function addUser(u) {
      if (!u?.login || seen.has(u.login)) return;
      seen.add(u.login);
      mentionUsers.push({ login: u.login, avatar_url: u.avatar_url || '' });
    }

    // Add PR author + requested reviewers (fetched during loadPR refresh)
    if (pr.prUser) addUser(pr.prUser);
    (pr.requestedReviewers || []).forEach(addUser);

    // Add commenters
    comments.forEach(c => addUser(c.user));

    // Fetch collaborators in background
    GitHubAPI.getCollaborators(pr.owner, pr.repo).then(collabs => {
      collabs.forEach(addUser);
    }).catch(() => {});
  }

  function attachMentionAutocomplete(textarea) {
    let dropdown = null;
    let mentionStart = -1;

    textarea.addEventListener('input', () => {
      const val = textarea.value;
      const cursor = textarea.selectionStart;

      // Find @ symbol before cursor
      const beforeCursor = val.substring(0, cursor);
      const atIdx = beforeCursor.lastIndexOf('@');

      if (atIdx === -1 || (atIdx > 0 && /\S/.test(val[atIdx - 1]))) {
        closeMentionDropdown();
        return;
      }

      const query = beforeCursor.substring(atIdx + 1).toLowerCase();
      if (query.includes(' ') || query.includes('\n')) {
        closeMentionDropdown();
        return;
      }

      mentionStart = atIdx;
      const matches = mentionUsers.filter(u => u.login.toLowerCase().startsWith(query)).slice(0, 6);

      if (matches.length === 0) {
        closeMentionDropdown();
        return;
      }

      showMentionDropdown(textarea, matches, query);
    });

    textarea.addEventListener('keydown', (e) => {
      if (!dropdown) return;
      const items = dropdown.querySelectorAll('.mdr-mention-item');
      const active = dropdown.querySelector('.mdr-mention-active');
      let idx = [...items].indexOf(active);

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        idx = (idx + 1) % items.length;
        items.forEach(i => i.classList.remove('mdr-mention-active'));
        items[idx].classList.add('mdr-mention-active');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        idx = (idx - 1 + items.length) % items.length;
        items.forEach(i => i.classList.remove('mdr-mention-active'));
        items[idx].classList.add('mdr-mention-active');
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (active) {
          e.preventDefault();
          insertMention(textarea, active.getAttribute('data-login'));
        }
      } else if (e.key === 'Escape') {
        closeMentionDropdown();
      }
    });

    textarea.addEventListener('blur', () => {
      setTimeout(closeMentionDropdown, 200);
    });

    function showMentionDropdown(ta, matches) {
      closeMentionDropdown();
      dropdown = document.createElement('div');
      dropdown.className = 'mdr-mention-dropdown';

      dropdown.innerHTML = matches.map((u, i) =>
        `<div class="mdr-mention-item ${i === 0 ? 'mdr-mention-active' : ''}" data-login="${u.login}">
          <img src="${u.avatar_url}" class="mdr-mention-avatar" alt="">
          <span>${u.login}</span>
        </div>`
      ).join('');

      // Position below textarea cursor
      const rect = ta.getBoundingClientRect();
      dropdown.style.position = 'fixed';
      dropdown.style.left = rect.left + 'px';
      dropdown.style.top = (rect.bottom + 2) + 'px';
      dropdown.style.minWidth = '180px';

      dropdown.querySelectorAll('.mdr-mention-item').forEach(item => {
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          insertMention(ta, item.getAttribute('data-login'));
        });
      });

      document.body.appendChild(dropdown);
    }

    function insertMention(ta, login) {
      const val = ta.value;
      const before = val.substring(0, mentionStart);
      const after = val.substring(ta.selectionStart);
      ta.value = before + '@' + login + ' ' + after;
      const newCursor = mentionStart + login.length + 2;
      ta.setSelectionRange(newCursor, newCursor);
      ta.focus();
      closeMentionDropdown();
    }

    function closeMentionDropdown() {
      if (dropdown) { dropdown.remove(); dropdown = null; }
      mentionStart = -1;
    }
  }

  function timeAgo(dateStr) {
    const s = Math.floor((Date.now() - new Date(dateStr)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return `${Math.floor(s/86400)}d ago`;
  }

  return { open, close };
})();
