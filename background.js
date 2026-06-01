// Handle SPA navigation on GitHub
// GitHub uses client-side routing (React), so content scripts
// may not re-inject when navigating between PR tabs.

// Listen for GitHub's SPA history changes
chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.url.match(/github\.com\/[^/]+\/[^/]+\/pull\/\d+/)) {
    // Re-inject content scripts on SPA navigation within PR pages
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['github-api.js', 'markdown-parser.js', 'content.js']
    }).catch(() => {});

    chrome.scripting.insertCSS({
      target: { tabId: details.tabId },
      files: ['content.css']
    }).catch(() => {});
  }
}, { url: [{ hostEquals: 'github.com' }] });

// Forward token updates to all matching tabs
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TOKEN_UPDATED') {
    chrome.tabs.query({ url: 'https://github.com/*/pull/*' }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'TOKEN_UPDATED' }).catch(() => {});
      }
    });
  }
  return false;
});
