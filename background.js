chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.url.match(/github\.com\/[^/]+\/[^/]+\/pull\/\d+/)) {
    chrome.scripting.executeScript({
      target: { tabId: details.tabId },
      files: ['lib/marked.min.js', 'github-api.js', 'overlay.js', 'content.js']
    }).catch(() => {});
    chrome.scripting.insertCSS({
      target: { tabId: details.tabId },
      files: ['overlay.css']
    }).catch(() => {});
  }
}, { url: [{ hostEquals: 'github.com' }] });

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'TOKEN_UPDATED') {
    chrome.tabs.query({ url: 'https://github.com/*/pull/*' }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'TOKEN_UPDATED' }).catch(() => {});
      }
    });
  }
});
