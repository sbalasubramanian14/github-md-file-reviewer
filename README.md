# GitHub MD Reviewer - Chrome Extension

A Chrome extension that lets you review rendered Markdown in GitHub Pull Requests with inline comments mapped back to source lines.

No more switching between rendered view and source diff just to leave a comment on documentation.

---

## Prerequisites

- Google Chrome (or any Chromium-based browser like Brave, Edge, Arc)
- A GitHub account
- A GitHub Personal Access Token (PAT)

---

## Step 1: Create a GitHub Personal Access Token

The extension needs a token to read PR data and post review comments on your behalf.

### 1.1 Go to GitHub Token Settings

Open this URL in your browser:

```
https://github.com/settings/tokens/new
```

Or navigate manually:
1. Click your **profile picture** (top-right) on GitHub
2. Go to **Settings**
3. Scroll down to **Developer settings** (bottom of the left sidebar)
4. Click **Personal access tokens** > **Tokens (classic)**
5. Click **Generate new token** > **Generate new token (classic)**

### 1.2 Configure the Token

| Field | Value |
|-------|-------|
| **Note** | `GitHub MD Reviewer` (or any name you like) |
| **Expiration** | Choose what works for you (90 days recommended) |
| **Scopes** | Check **`repo`** (this gives read/write access to repositories) |

> **Why `repo` scope?** The extension needs to:
> - Read file contents from PRs (to get raw Markdown)
> - Post review comments on your behalf
>
> The `repo` scope covers both. No other scopes are needed.

### 1.3 Generate and Copy

1. Click **Generate token**
2. **Copy the token immediately** - it starts with `ghp_` and you won't see it again
3. Store it somewhere safe (password manager, etc.)

---

## Step 2: Install the Extension Locally

### 2.1 Download/Clone the Extension

If you received the extension as a folder, you're ready. If it's a zip, extract it first.

Make sure the folder contains these files:
```
github-md-file-reviewer/
  manifest.json
  background.js
  content.js
  content.css
  github-api.js
  markdown-parser.js
  popup.html
  popup.css
  popup.js
  icons/
    icon16.png
    icon48.png
    icon128.png
```

### 2.2 Load in Chrome

1. Open Chrome and go to:
   ```
   chrome://extensions
   ```
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `github-md-file-reviewer` folder (the one containing `manifest.json`)
5. The extension should now appear in your extensions list with the name **"GitHub MD Reviewer"**

### 2.3 Pin the Extension (Optional but Recommended)

1. Click the **puzzle piece icon** in the Chrome toolbar
2. Find **GitHub MD Reviewer**
3. Click the **pin icon** to keep it visible

---

## Step 3: Connect Your GitHub Account

1. Click the **MD Reviewer** icon in the Chrome toolbar
2. Paste your GitHub Personal Access Token into the input field
3. Click **Connect**
4. If the token is valid, you'll see your GitHub profile with avatar and username
5. The status indicator will turn green

---

## Step 4: Start Reviewing

1. Open any GitHub Pull Request that contains `.md` file changes
2. Go to the **Files changed** tab
3. For any `.md` file, click the **rendered diff** toggle button (the document icon, usually labeled "Display the rich diff")
4. **Hover** over any heading, paragraph, list item, blockquote, or code block
5. A purple **comment button** will appear on the left
6. **Click it** to open the comment form
7. Write your review comment (Markdown supported)
8. Press **Submit** or use **Cmd+Enter** (Mac) / **Ctrl+Enter** (Windows)
9. The comment is posted as a native GitHub review comment on the correct source line

---

## Sharing with Others

Since this isn't published on the Chrome Web Store, others can install it by:

1. Share the entire `github-md-file-reviewer` folder (zip it up)
2. They follow the same steps above: **Step 1** (create their own token) and **Step 2** (load unpacked)
3. Each person needs their own GitHub PAT - tokens are stored locally in the browser

---

## Troubleshooting

### "Not connected" after entering token
- Make sure the token starts with `ghp_` or `github_pat_`
- Verify the token hasn't expired on GitHub
- Check that the `repo` scope is selected

### Comment button doesn't appear
- Make sure you're on the **Files changed** tab of a PR
- The file must be a `.md` file
- You must be viewing the **rendered diff** (not the source diff)
- Try refreshing the page

### "GitHub API error: 422" when submitting
- This usually means the line number mapping couldn't find the right diff position
- Try commenting on a different element
- Make sure the file actually has changes in the PR (not just viewed as context)

### Extension not loading
- Go to `chrome://extensions` and check for errors
- Click **Errors** on the extension card to see details
- Try clicking the reload button on the extension card

---

## How It Works (Technical)

1. When you open a PR files page, the extension detects `.md` files in the diff
2. It fetches the raw Markdown source via GitHub API
3. It parses the Markdown to build a map of block elements to source line numbers
4. It walks the rendered Markdown DOM on the page and matches elements sequentially
5. Each matched element gets a hover-activated comment button
6. When you submit a comment, it calls the GitHub Pull Request Review Comments API with the correct file path, commit SHA, and line number

---

## Supported Elements (MVP)

| Element | Supported |
|---------|-----------|
| Headings (h1-h6) | Yes |
| Paragraphs | Yes |
| List items | Yes |
| Blockquotes | Yes |
| Fenced code blocks | Yes |
| Tables | Not yet |
| Mermaid diagrams | Not yet |
| Embedded HTML | Not yet |

---

## Security Notes

- Your GitHub token is stored **locally** in Chrome's extension storage (`chrome.storage.local`)
- The token is **never** sent anywhere except to `api.github.com`
- No analytics, no telemetry, no external servers
- You can disconnect (delete the token) at any time from the extension popup

---

## Uninstalling

1. Go to `chrome://extensions`
2. Find **GitHub MD Reviewer**
3. Click **Remove**
4. Optionally, revoke your GitHub PAT at https://github.com/settings/tokens
