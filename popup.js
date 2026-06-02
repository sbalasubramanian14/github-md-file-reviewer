const tokenInput = document.getElementById('token-input');
const saveBtn = document.getElementById('save-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const toggleBtn = document.getElementById('toggle-visibility');
const statusBar = document.getElementById('status-bar');
const statusText = document.getElementById('status-text');
const tokenForm = document.getElementById('token-form');
const connectedInfo = document.getElementById('connected-info');
const errorMsg = document.getElementById('error-msg');
const helpLink = document.getElementById('help-link');

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
  setTimeout(() => { errorMsg.hidden = true; }, 5000);
}

function setConnected(user) {
  statusBar.className = 'status-bar status-connected';
  statusText.textContent = `Connected as ${user.login}`;
  tokenForm.hidden = true;
  connectedInfo.hidden = false;
  const avatar = document.getElementById('user-avatar');
  avatar.src = user.avatar_url;
  avatar.hidden = false;
  document.getElementById('user-name').textContent = user.name || user.login;
  document.getElementById('user-login').textContent = `@${user.login}`;
}

function setDisconnected() {
  statusBar.className = 'status-bar status-disconnected';
  statusText.textContent = 'Not connected';
  tokenForm.hidden = false;
  connectedInfo.hidden = true;
  tokenInput.value = '';
}

function setLoading(loading) {
  const btnText = saveBtn.querySelector('.btn-text');
  const btnLoader = saveBtn.querySelector('.btn-loader');
  btnText.textContent = loading ? 'Verifying...' : 'Connect';
  btnLoader.hidden = !loading;
  saveBtn.disabled = loading;
  tokenInput.disabled = loading;
}

async function verifyToken(token) {
  const res = await fetch('https://api.github.com/user', {
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'Invalid token' : `GitHub API error (${res.status})`);
  return res.json();
}

chrome.storage.local.get(['github_token', 'github_user'], (data) => {
  if (data.github_token && data.github_user) {
    setConnected(data.github_user);
  }
});

saveBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    showError('Please enter a token');
    return;
  }
  if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
    showError('Token should start with ghp_ or github_pat_');
    return;
  }

  setLoading(true);
  try {
    const user = await verifyToken(token);
    await chrome.storage.local.set({ github_token: token, github_user: user });
    setConnected(user);
    chrome.runtime.sendMessage({ type: 'TOKEN_UPDATED' });
  } catch (err) {
    showError(err.message);
  } finally {
    setLoading(false);
  }
});

disconnectBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove(['github_token', 'github_user']);
  setDisconnected();
  chrome.runtime.sendMessage({ type: 'TOKEN_UPDATED' });
});

toggleBtn.addEventListener('click', () => {
  const isPassword = tokenInput.type === 'password';
  tokenInput.type = isPassword ? 'text' : 'password';
});

tokenInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtn.click();
});

helpLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://github.com/settings/tokens/new?scopes=repo&description=GitHub+MD+Reviewer' });
});
