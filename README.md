# GitHub MD Reviewer

Review rendered Markdown in GitHub PRs with a full-page overlay viewer. Comment on any element — headings, paragraphs, lists, tables — like Google Docs.

Comments are posted as native GitHub review comments on the correct source line.

---

## Quick Install (3 minutes)

### 1. Get a GitHub Token

Go to **[github.com/settings/tokens/new](https://github.com/settings/tokens/new?scopes=repo&description=GitHub+MD+Reviewer)**

- **Scopes**: check `repo`
- Click **Generate token**
- Copy the token (starts with `ghp_`)

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

Done. Open any PR with `.md` files and look for the purple **MD Review** button in the bottom-right corner.

---

## How It Works

1. Open any GitHub Pull Request
2. Click the purple **MD Review** button (bottom-right corner)
3. The overlay opens with rendered markdown and a comment sidebar
4. **Hover** any element to see the comment button
5. **Click** to leave an inline comment
6. **Reply** to existing comments, or **edit/delete** your own
7. Comments appear as native GitHub review comments
8. Press **Esc** to close the overlay

---

## Features

- Full-page overlay with rendered markdown (powered by `marked.js`)
- Comment on headings, paragraphs, lists, blockquotes, code blocks, and table rows
- Threaded replies — same as GitHub's native comment threads
- Comments grouped and sorted by line number in the sidebar
- Inline badges on commented lines showing user avatars + count
- Different colors per user for easy visual distinction
- Edit and delete your own comments
- Click a sidebar comment to scroll to that line (and vice versa)
- Dark / Light mode (auto-detects system preference, toggle in topbar)
- File selector dropdown to switch between `.md` files in the PR

---

## Sharing with Others

1. Zip the `github-md-file-reviewer` folder
2. Share the zip
3. Each person follows the **Quick Install** steps above
4. Everyone needs their own GitHub PAT — tokens stay local

---

## Security

- Token stored locally in Chrome (`chrome.storage.local`)
- Only sent to `api.github.com` — nowhere else
- No analytics, no telemetry, no external servers
- Disconnect anytime from the extension popup

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| No "MD Review" button | Make sure you're on a PR page with `.md` files. Try refreshing. |
| Token rejected | Must start with `ghp_` or `github_pat_`. Needs `repo` scope. Check expiry. |
| Comment fails (422) | For new files, all lines are commentable. For modified files, only lines in the diff can receive comments. |
| Extension not loading | Go to `chrome://extensions`, check for errors, click reload. |

---

## Uninstalling

1. Go to `chrome://extensions`
2. Remove **GitHub MD Reviewer**
3. Optionally revoke your PAT at [github.com/settings/tokens](https://github.com/settings/tokens)
