const statusEl = document.getElementById('status-value');
const actionsEl = document.getElementById('actions');
const messageEl = document.getElementById('message');

function setMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.style.color = isError ? '#d93025' : '#5f6368';
}

function renderSignedOut() {
  statusEl.textContent = 'Not signed in';
  statusEl.className = 'status-value signed-out';

  actionsEl.innerHTML = '';

  const signInBtn = document.createElement('button');
  signInBtn.className = 'btn-primary';
  signInBtn.textContent = 'Sign in with Google';
  signInBtn.addEventListener('click', async () => {
    signInBtn.disabled = true;
    signInBtn.textContent = 'Signing in…';
    setMessage('');
    try {
      await chrome.runtime.sendMessage({ action: 'signIn' });
    } catch {
      // ignore — refreshStatus below will pick up the result
    }
    await refreshStatus();
  });

  actionsEl.appendChild(signInBtn);
}

function renderSignedIn(email, folderLink) {
  statusEl.textContent = `Signed in as ${email}`;
  statusEl.className = 'status-value signed-in';

  actionsEl.innerHTML = '';

  if (folderLink) {
    const link = document.createElement('a');
    link.className = 'drive-link';
    link.href = folderLink;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open "Gemini Chats" in Drive';
    actionsEl.appendChild(link);
  } else {
    const note = document.createElement('p');
    note.style.cssText = 'font-size:12px;color:#5f6368;text-align:center;';
    note.textContent = 'No Drive folder yet. Save a chat to create it.';
    actionsEl.appendChild(note);
  }

  // Format selector
  const formatRow = document.createElement('div');
  formatRow.className = 'format-row';

  const label = document.createElement('span');
  label.textContent = 'Save as:';
  formatRow.appendChild(label);

  const toggleGroup = document.createElement('div');
  toggleGroup.className = 'toggle-group';

  const mdBtn = document.createElement('button');
  mdBtn.textContent = 'Markdown';
  const docBtn = document.createElement('button');
  docBtn.textContent = 'Google Doc';

  toggleGroup.appendChild(mdBtn);
  toggleGroup.appendChild(docBtn);
  formatRow.appendChild(toggleGroup);
  actionsEl.appendChild(formatRow);

  function applyFormat(fmt) {
    mdBtn.classList.toggle('active', fmt === 'markdown');
    docBtn.classList.toggle('active', fmt === 'googledoc');
  }

  chrome.storage.sync.get({ saveFormat: 'markdown' }, ({ saveFormat }) => {
    applyFormat(saveFormat);
  });

  mdBtn.addEventListener('click', () => {
    applyFormat('markdown');
    chrome.storage.sync.set({ saveFormat: 'markdown' });
  });
  docBtn.addEventListener('click', () => {
    applyFormat('googledoc');
    chrome.storage.sync.set({ saveFormat: 'googledoc' });
  });

  const signOutBtn = document.createElement('button');
  signOutBtn.className = 'btn-danger';
  signOutBtn.textContent = 'Sign out';
  signOutBtn.addEventListener('click', async () => {
    signOutBtn.disabled = true;
    setMessage('Signing out…');
    await chrome.runtime.sendMessage({ action: 'signOut' });
    await refreshStatus();
  });
  actionsEl.appendChild(signOutBtn);
}

async function refreshStatus() {
  setMessage('');
  statusEl.textContent = 'Loading…';
  statusEl.className = 'status-value';
  actionsEl.innerHTML = '';

  try {
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
    if (status.signedIn) {
      renderSignedIn(status.email, status.folderLink);
    } else {
      renderSignedOut();
    }
  } catch (err) {
    statusEl.textContent = 'Error';
    setMessage(`Could not load status: ${err.message}`, true);
  }
}

refreshStatus();
