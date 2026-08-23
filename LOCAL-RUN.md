# LOCAL-RUN — testing this extension on a real GitHub PR

This document lets another agent (or a human) reproduce the full manual test
loop used to develop and verify the extension against a live GitHub Pull
Request. It assumes a headed browser that can load an unpacked extension and be
driven programmatically (any Playwright/CDP-based headed browser works; the
commands below use a generic `browse` CLI wrapper — substitute your own).

## What the extension is

A Manifest V3 Chrome extension that overlays rendered Markdown on GitHub PR
pages. It fetches `.md`/`.markdown`/`.mdx` files from the PR head, renders them
(marked + DOMPurify + mermaid), and lets you comment on any block as a native
GitHub review comment. It also has a review-batch mode and an edit mode that
commits back to the PR branch.

Key files:
- `manifest.json` — MV3 manifest; content scripts + injected lib list
- `content.js` — injects the floating **MD Review** button on PR pages (bump `VERSION` to force re-init after a code change)
- `overlay.js` — the whole overlay UI (rendering, line mapping, comments, review mode, edit mode, file tree, mermaid, rich editor)
- `github-api.js` — GitHub REST wrapper (uses `cache: 'no-store'` — see gotchas)
- `background.js` — re-injects scripts on SPA navigation
- `overlay.css` — themed styles (light/dark via `[data-theme]` + CSS vars)
- `lib/` — bundled `marked`, `purify` (DOMPurify), `mermaid`, `toastui-editor-all` + its two CSS themes

## Prerequisites

1. A GitHub Personal Access Token with `repo` scope (fine-grained works too).
2. A test PR that contains at least one Markdown file. Create a scratch repo,
   add a Markdown doc that exercises every block type (headings, paragraphs,
   bullet + numbered lists, a table, fenced code, a blockquote, and a couple of
   ```` ```mermaid ```` diagrams), edit an existing `.md` too (to test comments
   on modified files), and open a draft PR. Placeholders below: `OWNER/REPO`
   and PR `#NNN`.

## Launch a headed browser WITH this extension loaded

Point your headed browser at this extension directory as an unpacked extension.
With the generic `browse` wrapper, that means setting the extension dir and
connecting:

```bash
EXT_DIR="/absolute/path/to/github-md-file-reviewer"
# clean any stale server / chromium locks first if your tool needs it
BROWSE_EXTENSIONS_DIR="$EXT_DIR" browse connect
```

Verify the extension actually loaded (many headless tools block `chrome://`
URLs, so check the browser process args instead):

```bash
ps -ww -o command= -p "$(pgrep -f 'Chrome' | head -1)" | tr ' ' '\n' | grep -i load-extension
```

The GitHub web login and the extension's PAT persist in the browser profile, so
you only log in / paste the token once (via the extension popup — a human does
this; an agent cannot).

## Reloading after a code change

Unpacked extensions reload on browser relaunch. After editing any file, stop and
reconnect the browser (clear the Chromium profile `Singleton*` lock files first
if your tooling leaves them behind), then reopen the PR.

## Driving the overlay

Everything is scriptable with the browser's JS-eval command. Open the overlay
and interact:

```bash
browse goto "https://github.com/OWNER/REPO/pull/NNN/files"; sleep 4
browse js "document.getElementById('mdr-floating-btn').click()"; sleep 5
# pick a file from the tree
browse js "[...document.querySelectorAll('.mdr-tree-file')].find(r => r.getAttribute('data-path')==='path/to/file.md').click()"
```

Verify comments landed correctly via the API (the ground truth):

```bash
gh api "repos/OWNER/REPO/pulls/NNN/comments?per_page=100" \
  --jq '.[] | "\(.line)\t\(.path)\t\(.body[0:50])"'
```

## Test checklist

1. **Comment anchoring** — comment on a modified file line and on a new-file
   line; confirm the API shows the exact `line` with `side: RIGHT`.
2. **Block types** — comment on H1, H2, paragraph, bullet + numbered list item,
   table row, blockquote, code-block line, mermaid block. Each must anchor to its
   real source line. (Blockquotes beginning with `> **bold**` were a past bug.)
3. **Non-diff lines** — on a modified file, buttons on lines outside the diff are
   disabled with a tooltip; the stats bar shows "N/M commentable".
4. **Review batch** — Start Review, add drafts across two files, remove one, submit
   as COMMENT; drafts persist across refresh; only the intended draft is removed.
5. **Escape** — Escape inside a comment form closes only the form, not the overlay.
6. **XSS** — a comment containing `<img onerror>` / `<script>` renders inert
   (DOMPurify); the injected JS never runs.
7. **Mermaid** — ```` ```mermaid ```` renders as a diagram in both themes, with a
   View source toggle; the diagram is commentable on the fence line.
8. **File tree** — nested dirs render, collapse/expand, collapse-to-rail persists,
   active file highlighted, `+N` additions shown.
9. **Edit mode (raw)** — split editor + live preview; edit, commit via Contents
   API; the branch gets a new commit, head sha refreshes, comments after commit
   anchor to the new sha; unsaved edits persist across a browser restart.
10. **Edit mode (rich)** — Raw|Rich toggle; Toast UI WYSIWYG round-trips to
    markdown (verify: a toolbar horizontal rule syncs back as `***`).

## Gotchas discovered

- **HTTP cache aliasing**: Chrome keys its cache on URL only, so a `contents/`
  request with a raw `Accept` header can get a cached response served to a JSON
  `Accept` request for the same URL, producing "Unexpected token '#'" JSON errors.
  All API calls use `cache: 'no-store'`.
- **ProseMirror + synthetic input**: a browser JS-eval runs in the page's main
  world, not the content script's isolated world, and synthetic keyboard/paste
  events do not register in ProseMirror's document state. To verify the rich
  editor's markdown sync, use a toolbar command
  (e.g. `.toastui-editor-toolbar button.hrline`) which goes through ProseMirror's
  real command pipeline, then switch to Raw and check the textarea.
- **querySelector on mermaid blocks**: the hidden source `<pre>` inside a mermaid
  block also contains comment buttons, and they come first in DOM order. A real
  user clicks the visible wrapper button (fence line); a script must pick the
  wrapper's direct-child button, not `block.querySelector('.mdr-comment-btn')`.
- **confirm() dialogs**: cancel/discard use `window.confirm`; in automation arm
  your tool's dialog-accept first or the dialog is auto-dismissed (returns false).

## Cleanup after testing

```bash
# delete test comments matching a marker you used in the bodies
for id in $(gh api "repos/OWNER/REPO/pulls/NNN/comments?per_page=100" \
  --jq '.[] | select(.body | test("REGRESSION|PROBE|TEST")) | .id'); do
  gh api -X DELETE "repos/OWNER/REPO/pulls/comments/$id"
done
# when fully done: close the draft PR, delete the test branch, remove any worktree
```
