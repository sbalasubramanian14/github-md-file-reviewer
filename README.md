# GitHub MD Reviewer

A Chrome (Manifest V3) extension that lets you review **rendered** Markdown in a GitHub Pull Request — headings, paragraphs, lists, tables, code, and Mermaid diagrams — and comment on any block like Google Docs.

Every comment is posted as a **native GitHub review comment**, anchored to the correct source line. Nothing is stored outside GitHub and your own browser.

> **Why:** GitHub's review system is source-line based, so line comments only work in the raw diff view. But docs — READMEs, architecture notes, onboarding guides, AI context files — are meant to be read rendered. This extension closes that gap without changing how the comments end up on GitHub.

**Version 3.0.0**

---

## Quick Install (3 minutes)

### 1. Get a GitHub Token

Go to **[github.com/settings/tokens/new](https://github.com/settings/tokens/new?scopes=repo&description=GitHub+MD+Reviewer)**

- **Scopes**: check `repo`
- Click **Generate token**
- Copy the token (starts with `ghp_`)

A fine-grained PAT works too. It needs read/write on **Pull requests** and **Contents** (Contents is only required if you want to use Edit mode to commit changes).

### 2. Load the Extension

1. Unzip the folder if needed
2. Open `chrome://extensions` in Chrome
3. Turn on **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `github-md-file-reviewer` folder

### 3. Connect

1. Click the **MD Reviewer** extension icon in the toolbar
2. Paste your token
3. Click **Connect**

Done. Open any PR containing `.md` / `.markdown` / `.mdx` files and look for the purple **MD Review** button in the bottom-right corner.

---

## How It Works

1. Open a GitHub Pull Request
2. Click the purple **MD Review** button (bottom-right corner)
3. The overlay opens: file tree on the left, rendered Markdown in the middle, comment sidebar on the right
4. **Hover** any block to reveal the comment button
5. **Click** to leave an inline comment
6. **Reply** to threads, **resolve** them, or **edit/delete** your own comments
7. Comments appear as native GitHub review comments on the correct source line
8. Press **Esc** to close the overlay

Under the hood: the file is fetched from the PR head commit by sha, rendered with `marked`, sanitized with DOMPurify, and every rendered block is mapped back to its source line number. That line is what gets sent to GitHub's review API with `side: RIGHT`.

---

## Features

### Reviewing

- **Full-page overlay** with rendered Markdown — no more toggling between rendered and raw views
- **Comment on any block** — headings, paragraphs, list items, blockquotes, table rows, individual lines inside fenced code blocks, and Mermaid diagrams
- **Correct line anchoring** via GitHub's modern `line` / `side` review API, on both new and modified files
- **Non-commentable lines are marked, not failed** — on modified files, lines outside the PR diff get a disabled button with a tooltip, and the stats bar shows `N/M commentable` (a GitHub API limitation, surfaced instead of erroring)
- **Threaded replies** — the same threads as GitHub's native UI
- **Resolve / reopen threads** straight from the sidebar; resolved threads collapse to a one-line bar you can expand in place
- **Edit and delete** your own comments
- **Sidebar grouped and sorted by line**, with click-to-scroll in both directions
- **Inline badges** on commented lines showing commenter avatars and a count
- **Per-user colors** so threads are easy to tell apart at a glance
- **@mention autocomplete** for PR participants and repo collaborators
- **Comment bodies render as Markdown**, matching how GitHub displays them

### Review mode

- **Batch comments locally**, then submit once as a single review — **Approve**, **Request changes**, or **Comment**
- **Drafts persist** in `chrome.storage.local` and survive a refresh or browser restart
- Pending comments show as badges on their lines and can be removed individually before submitting
- After submitting, the sidebar polls until GitHub returns the new comments, so they appear without a manual refresh

### Reading

- **Diff-aware view** — on modified files, show only the changed blocks, with headings kept for context and a green change-rail marking each change; toggle to the full document anytime. New files open in full.
- **Collapsible file tree** — the real directory structure of the PR's Markdown files, with per-file addition counts; collapses to a rail to reclaim space
- **Mermaid diagrams** — ` ```mermaid ` blocks render as diagrams with a **View source** toggle, theme-aware
- **Dark / light mode** — auto-detects your system preference, with a topbar toggle; applies to the tree, editors, and diagrams
- **Download** the raw `.md` file from the topbar

### Editing

- **Edit mode** with two views:
  - **Raw** — source editor with live preview
  - **Rich** — WYSIWYG editor (Toast UI) that round-trips back to Markdown
- **Commit straight to the PR branch** with your own commit message; the head sha refreshes afterwards so later comments anchor to the new commit
- **Unsaved edits persist** per file across sessions

### Compatibility

- **Fork PRs** — files are fetched by commit sha (a fork's branch doesn't exist in the base repo, but its commits are reachable there), and edits commit to the head repo
- **SPA navigation** — the background service worker re-injects on GitHub's client-side route changes
- **Deleted files are skipped** — they can't be viewed at head or commented on the `RIGHT` side

---

## Project Structure

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest — permissions, content scripts, injected lib list |
| `content.js` | Detects PR pages and injects the floating **MD Review** button |
| `overlay.js` | The whole overlay UI — rendering, line mapping, comments, review mode, edit mode, file tree, Mermaid, rich editor |
| `github-api.js` | GitHub REST + GraphQL wrapper (GraphQL is used for review-thread resolve/reopen) |
| `background.js` | Re-injects scripts and CSS on SPA navigation; broadcasts token updates |
| `overlay.css` | Themed styles — light/dark via `[data-theme]` and CSS variables |
| `popup.html` / `popup.js` / `popup.css` | Token connect/disconnect UI |
| `lib/` | Vendored third-party libraries (see below) |
| `LOCAL-RUN.md` | How to run the full manual test loop against a live PR |

### Bundled libraries

MV3's content security policy forbids loading scripts from a CDN, so dependencies are vendored in `lib/`:

| Library | Version | Used for |
|---------|---------|----------|
| `marked` | 15.0.7 | Markdown → HTML rendering |
| `DOMPurify` | 3.2.4 | Sanitizing rendered HTML and comment bodies |
| `mermaid` | bundled ESM build | Rendering ` ```mermaid ` diagram blocks |
| `@toast-ui/editor` | 3.2.2 | The Rich (WYSIWYG) editor in Edit mode |

---

## Permissions

| Permission | Why |
|------------|-----|
| `storage` | Store your PAT, theme, draft comments, and unsaved edits locally |
| `activeTab` / `scripting` | Inject the overlay into GitHub PR pages |
| `webNavigation` | Detect GitHub's SPA route changes in order to re-inject |
| `https://github.com/*` | Run on PR pages |
| `https://api.github.com/*` | Read the PR, files, and comments; post reviews and commits |

---

## Security

- The token is stored locally in `chrome.storage.local` — it never leaves your browser except to `api.github.com`
- All rendered Markdown and comment bodies pass through DOMPurify, so a malicious document or comment can't run script in the overlay
- No analytics, no telemetry, no external servers, no third-party backend
- Disconnect anytime from the extension popup; revoke the PAT at [github.com/settings/tokens](https://github.com/settings/tokens)

---

## Known Limitations

- **Comments only land on lines in the diff.** GitHub's review API rejects comments on unchanged lines of a modified file. The overlay disables those buttons rather than letting the post fail.
- **Chrome / Chromium only.** MV3 with a service worker; not tested on Firefox.
- **Comments are posted against the PR head as of when the overlay opened.** If someone pushes while it's open, reopen it to pick up the new sha.
- **Edit mode commits directly to the PR branch** — there is no local staging or conflict resolution. If the file changed upstream since you opened it, the commit is rejected with a sha mismatch.
- **Rendering is `marked`, not GitHub's renderer.** Output is very close but not byte-identical — GFM alerts and some HTML-in-Markdown edge cases can differ.

---

## Sharing with Others

1. Zip the `github-md-file-reviewer` folder
2. Share the zip
3. Each person follows the **Quick Install** steps above
4. Everyone needs their own GitHub PAT — tokens stay local to each browser

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| No "MD Review" button | Make sure you're on a PR page that contains `.md` files, and that your token is connected. Try refreshing. |
| Token rejected | Must start with `ghp_` or `github_pat_`. Needs `repo` scope. Check expiry. |
| Comment fails (422) | For new files, all lines are commentable. For modified files, only lines in the diff can receive comments. |
| Commit fails with a sha mismatch | The file changed on the branch since you opened it. Close and reopen the overlay to reload the latest version. |
| Diagrams don't render | Confirm the fence is exactly ` ```mermaid `. Use **View source** to check the diagram syntax. |
| Extension not loading | Go to `chrome://extensions`, check for errors, click reload. After changing code, reload the extension and refresh the PR tab. |

---

## Development

See **[LOCAL-RUN.md](LOCAL-RUN.md)** for the full manual test loop against a live PR, including the test checklist and the non-obvious gotchas (HTTP cache aliasing, ProseMirror synthetic input, Mermaid block selectors).

After changing any file: reload the extension at `chrome://extensions`, then refresh the PR tab. Bump `VERSION` in `content.js` to force re-initialization of an already-injected page.

---

## Uninstalling

1. Go to `chrome://extensions`
2. Remove **GitHub MD Reviewer**
3. Optionally revoke your PAT at [github.com/settings/tokens](https://github.com/settings/tokens)
