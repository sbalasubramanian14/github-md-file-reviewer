(() => {
  const VERSION = 4;
  if (window.__MDR_VERSION__ === VERSION) {
    if (window.__MDR_REINIT__) window.__MDR_REINIT__();
    return;
  }
  window.__MDR_VERSION__ = VERSION;

  const log = (...args) => console.log('[MD Reviewer]', ...args);
  const logError = (...args) => console.error('[MD Reviewer]', ...args);

  let prData = null;
  let filesMeta = null;
  let processedDiffs = new Set();
  let pendingDiffs = new Set();
  let initTimer = null;
  const diffCache = new Map();

  function showToast(message, type = 'success') {
    document.querySelectorAll('.mdr-toast').forEach(t => t.remove());
    const toast = document.createElement('div');
    toast.className = `mdr-toast mdr-toast-${type}`;
    const icons = { success: '\u2713', error: '\u2717', info: '\u2139' };
    toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'mdr-toast-out 0.2s ease-in forwards';
      setTimeout(() => toast.remove(), 200);
    }, 3500);
  }

  function scheduleInit() {
    if (initTimer) clearTimeout(initTimer);
    initTimer = setTimeout(init, 300);
  }

  async function init() {
    log('v' + VERSION, 'init');

    const token = await GitHubAPI.getToken();
    if (!token) return;

    const parsed = GitHubAPI.parsePRUrl(window.location.href);
    if (!parsed) return;

    try {
      const [pr, files] = await Promise.all([
        GitHubAPI.getPullRequest(parsed.owner, parsed.repo, parsed.pullNumber),
        GitHubAPI.getPullRequestFiles(parsed.owner, parsed.repo, parsed.pullNumber)
      ]);
      prData = { ...parsed, headSha: pr.head.sha, baseSha: pr.base.sha, headRef: pr.head.ref };
      filesMeta = files;
    } catch (err) {
      logError('Failed to load PR data:', err);
      return;
    }

    scanForRenderedMarkdown();
    startObserver();
  }

  function scanForRenderedMarkdown() {
    if (!prData || !filesMeta) return;
    const mdFiles = filesMeta.filter(f => f.filename.endsWith('.md'));
    if (mdFiles.length === 0) return;

    const diffContainers = document.querySelectorAll('[role="region"][id^="diff-"]');

    for (const container of diffContainers) {
      if (processedDiffs.has(container.id)) continue;

      const filePath = resolveFilePath(container);
      if (!filePath || !filePath.endsWith('.md')) continue;

      const mdFile = mdFiles.find(f => f.filename === filePath);
      if (!mdFile) continue;

      const richDiffRoot = container.querySelector('.prose-diff, article.markdown-body');
      if (!richDiffRoot) {
        if (!pendingDiffs.has(container.id)) {
          pendingDiffs.add(container.id);
          log(`${filePath.split('/').pop()}: waiting for rich diff toggle...`);
        }
        continue;
      }

      pendingDiffs.delete(container.id);
      processContainer(richDiffRoot, container.id, mdFile);
    }
  }

  function resolveFilePath(container) {
    const el = container.querySelector('[data-file-path]');
    if (el) return el.getAttribute('data-file-path');
    const btn = container.querySelector('button[aria-label*=".md"]');
    if (btn) {
      const m = (btn.getAttribute('aria-label') || '').match(/:\s*(.+\.md)$/);
      if (m) return m[1];
    }
    return null;
  }

  async function getDiffPositionMap(filePath) {
    if (diffCache.has(filePath)) return diffCache.get(filePath);
    const files = await GitHubAPI.getPullRequestFiles(prData.owner, prData.repo, prData.pullNumber);
    const file = files.find(f => f.filename === filePath);
    if (!file || !file.patch) { diffCache.set(filePath, null); return null; }
    const map = GitHubAPI.buildDiffPositionMap(file.patch);
    diffCache.set(filePath, map);
    return map;
  }

  async function processContainer(richDiffRoot, containerId, mdFile) {
    try {
      const rawMarkdown = await GitHubAPI.getRawFileContent(
        prData.owner, prData.repo, mdFile.filename, prData.headRef
      );
      const blocks = MarkdownParser.parse(rawMarkdown);
      const positionMap = await getDiffPositionMap(mdFile.filename);

      if (!positionMap || positionMap.size === 0) {
        log(`${mdFile.filename}: no diff positions found`);
        return;
      }

      // Log diff coverage
      const diffLines = [...positionMap.keys()].sort((a,b) => a-b);
      log(`${mdFile.filename}: diff covers lines ${diffLines[0]}-${diffLines[diffLines.length-1]} (${diffLines.length} lines)`);

      // Only find elements that are CHANGED (inside <ins> tags or with 'added' class)
      const changedElements = getChangedElements(richDiffRoot);
      log(`${mdFile.filename}: ${changedElements.length} changed DOM elements`);

      if (changedElements.length === 0) return;

      // Match changed elements to parsed blocks via content-based matching
      const mappings = matchChangedElements(changedElements, null, blocks, positionMap);
      log(`${mdFile.filename}: ${mappings.length} mapped to diff positions`);

      let count = 0;
      for (const mapping of mappings) {
        injectCommentButton(mapping, mdFile.filename);
        highlightChanged(mapping.element);
        count++;
      }

      if (count > 0) {
        processedDiffs.add(containerId);
        showToast(`${count} changed elements ready for review`, 'info');
      }
    } catch (err) {
      logError(`Error: ${mdFile.filename}:`, err);
    }
  }

  // Find only elements that represent CHANGES in the diff
  function getChangedElements(root) {
    const elements = [];
    const seen = new Set();

    function add(el) {
      if (seen.has(el) || el.tagName === 'A' || el.tagName === 'SVG') return;
      if (el.closest('[class*="DiffFileHeader"]')) return;
      seen.add(el);
      elements.push(el);
    }

    // Elements inside <ins> tags (added content)
    root.querySelectorAll('ins h1, ins h2, ins h3, ins h4, ins h5, ins h6').forEach(add);
    root.querySelectorAll('ins li').forEach(add);
    root.querySelectorAll('ins p').forEach(add);
    root.querySelectorAll('ins blockquote').forEach(add);
    root.querySelectorAll('ins pre').forEach(add);
    root.querySelectorAll('ins ul').forEach(el => {
      // If the whole list is added, add individual items
      el.querySelectorAll('li').forEach(add);
    });

    // Elements with 'added' class directly
    root.querySelectorAll('.added.rich-diff-level-zero, .added.rich-diff-level-one').forEach(el => {
      const tag = el.tagName.toLowerCase();
      if (['h1','h2','h3','h4','h5','h6','p','li','blockquote','pre'].includes(tag)) {
        add(el);
      } else if (tag === 'ul' || tag === 'ol') {
        el.querySelectorAll('li').forEach(add);
      }
    });

    // Headings with .heading-element inside <ins>
    root.querySelectorAll('ins .heading-element').forEach(add);

    // Sort in document order
    elements.sort((a, b) => {
      const pos = a.compareDocumentPosition(b);
      return (pos & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 :
             (pos & Node.DOCUMENT_POSITION_PRECEDING) ? 1 : 0;
    });

    return elements;
  }


  function normalizeText(text) {
    return (text || '')
      .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
      .replace(/\*(.+?)\*/g, '$1')       // italic
      .replace(/__(.+?)__/g, '$1')       // bold
      .replace(/_(.+?)_/g, '$1')         // italic
      .replace(/`([^`]+)`/g, '$1')       // inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
      .replace(/!\[[^\]]*\]\([^)]+\)/g, '')    // images
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
      .substring(0, 100);
  }

  function matchChangedElements(changedElements, allElements, blocks, positionMap) {
    const results = [];

    for (const el of changedElements) {
      const elType = MarkdownParser.getElementType(el);
      if (!elType) continue;

      const elText = normalizeText(el.textContent);
      if (!elText) continue;

      // Find the best matching block by text similarity
      let bestBlock = null;
      let bestScore = 0;

      for (const block of blocks) {
        if (block.type !== elType) continue;

        const blockText = normalizeText(block.text || '');
        if (!blockText) continue;

        let score = 0;
        if (elText === blockText) {
          score = 100;
        } else if (elText.startsWith(blockText.substring(0, 50)) || blockText.startsWith(elText.substring(0, 50))) {
          score = 90;
        } else if (elText.startsWith(blockText.substring(0, 25)) || blockText.startsWith(elText.substring(0, 25))) {
          score = 75;
        } else if (elText.includes(blockText.substring(0, 20)) || blockText.includes(elText.substring(0, 20))) {
          score = 60;
        }

        // Prefer blocks whose line numbers are in the diff
        if (score > 0 && positionMap.has(block.startLine)) {
          score += 10;
        }

        if (score > bestScore) {
          bestScore = score;
          bestBlock = block;
        }
      }

      if (!bestBlock || bestScore < 60) {
        log(`  No block match for <${el.tagName}> "${elText.substring(0, 40)}" (best score: ${bestScore})`);
        continue;
      }

      const diffResult = GitHubAPI.findNearestDiffPosition(bestBlock.startLine, positionMap);
      if (!diffResult) {
        log(`  No diff position for L${bestBlock.startLine}: "${elText.substring(0, 40)}"`);
        continue;
      }

      if (!diffResult.exact && Math.abs(diffResult.line - bestBlock.startLine) > 3) continue;

      results.push({
        element: el,
        block: bestBlock,
        startLine: bestBlock.startLine,
        endLine: bestBlock.endLine,
        diffPosition: diffResult.position,
        diffLine: diffResult.line,
        exact: diffResult.exact
      });

      log(`  Mapped: "${elText.substring(0, 40)}" → L${bestBlock.startLine} → pos ${diffResult.position}`);
    }

    return results;
  }

  function highlightChanged(el) {
    if (el.classList.contains('mdr-changed')) return;
    el.classList.add('mdr-changed');
  }

  function injectCommentButton(mapping, filePath) {
    const el = mapping.element;
    if (el.querySelector('.mdr-comment-btn')) return;

    el.classList.add('mdr-hoverable');

    const btn = document.createElement('button');
    btn.className = 'mdr-comment-btn';
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2v2.19l2.72-2.72.53-.22h4.25a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75z"/></svg>`;
    btn.title = `Comment on line ${mapping.startLine}`;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCommentForm(mapping, filePath);
    });

    el.appendChild(btn);
  }

  function openCommentForm(mapping, filePath) {
    document.querySelectorAll('.mdr-comment-overlay').forEach(o => o.remove());
    const contextText = mapping.element.textContent?.substring(0, 200) || '';
    const typeLabels = { heading: 'Heading', paragraph: 'Paragraph', listitem: 'List Item', blockquote: 'Blockquote', code: 'Code Block' };

    const overlay = document.createElement('div');
    overlay.className = 'mdr-comment-overlay';
    overlay.innerHTML = `
      <div class="mdr-comment-form">
        <div class="mdr-form-header">
          <div class="mdr-form-header-left">
            <div class="mdr-form-icon">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0113.25 12H9.06l-2.573 2.573A1.458 1.458 0 014 13.543V12H2.75A1.75 1.75 0 011 10.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h2v2.19l2.72-2.72.53-.22h4.25a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25H2.75z"/>
              </svg>
            </div>
            <div>
              <div class="mdr-form-title">Review Comment</div>
              <div class="mdr-form-subtitle">${escapeHtml(filePath)}</div>
            </div>
          </div>
          <button class="mdr-form-close" id="mdr-close">&times;</button>
        </div>
        <div class="mdr-context">
          <div class="mdr-context-label">${typeLabels[mapping.block.type] || 'Element'} &middot; Line ${mapping.startLine}</div>
          <div class="mdr-context-text">${escapeHtml(contextText)}</div>
        </div>
        <div class="mdr-form-body">
          <textarea class="mdr-textarea" id="mdr-comment-text" placeholder="Leave a review comment..." autofocus></textarea>
          <div class="mdr-form-hint">Supports Markdown &middot; <kbd>Cmd+Enter</kbd> to submit</div>
        </div>
        <div class="mdr-form-footer">
          <div class="mdr-line-badge">
            Target: <code>L${mapping.startLine}</code> &rarr; diff position <code>${mapping.diffPosition}</code>
          </div>
          <div class="mdr-form-actions">
            <button class="mdr-btn mdr-btn-cancel" id="mdr-cancel">Cancel</button>
            <button class="mdr-btn mdr-btn-submit" id="mdr-submit">Submit</button>
          </div>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    const textarea = overlay.querySelector('#mdr-comment-text');
    const submitBtn = overlay.querySelector('#mdr-submit');
    const close = () => overlay.remove();

    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    overlay.querySelector('#mdr-cancel').addEventListener('click', close);
    overlay.querySelector('#mdr-close').addEventListener('click', close);
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    textarea.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submitBtn.click();
    });
    setTimeout(() => textarea.focus(), 50);

    submitBtn.addEventListener('click', async () => {
      const comment = textarea.value.trim();
      if (!comment) {
        textarea.style.borderColor = '#ef4444';
        setTimeout(() => { textarea.style.borderColor = ''; }, 1500);
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
      try {
        await GitHubAPI.createReviewComment(prData.owner, prData.repo, prData.pullNumber, {
          body: comment,
          commitId: prData.headSha,
          path: filePath,
          position: mapping.diffPosition
        });
        close();
        showToast('Comment posted successfully');
      } catch (err) {
        logError('Submit error:', err);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit';
        showToast(err.message || 'Failed to post comment', 'error');
      }
    });
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  let observer = null;
  function startObserver() {
    if (observer) return;
    let debounce = null;
    observer = new MutationObserver(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(scanForRenderedMarkdown, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.__MDR_REINIT__ = () => {
    log('Re-init (SPA)');
    prData = null; filesMeta = null;
    processedDiffs = new Set(); pendingDiffs = new Set(); diffCache.clear();
    scheduleInit();
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'TOKEN_UPDATED') {
      prData = null; filesMeta = null;
      processedDiffs = new Set(); pendingDiffs = new Set(); diffCache.clear();
      scheduleInit();
    }
  });

  scheduleInit();
})();
