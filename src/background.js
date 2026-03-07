/**
 * background.js — Manifest V3 service worker
 *
 * Handles:
 *  1. OAuth2 via chrome.identity
 *  2. Google Drive folder lookup / creation
 *  3. Markdown file upload
 */

const FOLDER_NAME = 'Gemini Chats';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'saveChat') {
    handleSaveChat(msg).then(sendResponse).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true; // keep channel open for async response
  }

  if (msg.action === 'getStatus') {
    getStatus().then(sendResponse).catch(() => sendResponse({ signedIn: false }));
    return true;
  }

  if (msg.action === 'signOut') {
    signOut().then(sendResponse);
    return true;
  }
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function getToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

async function getStatus() {
  try {
    const token = await getToken(false);
    if (!token) return { signedIn: false };

    const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const info = await res.json();

    const { folderId, folderLink } = await chrome.storage.local.get(['folderId', 'folderLink']);
    return { signedIn: true, email: info.email, folderId, folderLink };
  } catch {
    return { signedIn: false };
  }
}

async function signOut() {
  const { token } = await new Promise(resolve =>
    chrome.identity.getAuthToken({ interactive: false }, t => resolve({ token: t }))
  );
  if (token) {
    await new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
  }
  await chrome.storage.local.remove(['folderId', 'folderLink']);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Drive helpers
// ---------------------------------------------------------------------------

async function driveRequest(url, options, token) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401) {
    // Token expired — remove and retry once with a fresh token
    await new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
    const newToken = await getToken(true);
    return driveRequest(url, options, newToken);
  }

  return res;
}

async function ensureFolder(token) {
  // Check cache first
  const cached = await chrome.storage.local.get('folderId');
  if (cached.folderId) {
    // Verify folder still exists
    const res = await driveRequest(
      `${DRIVE_API}/files/${cached.folderId}?fields=id,trashed`,
      { method: 'GET' },
      token
    );
    if (res.ok) {
      const data = await res.json();
      if (!data.trashed) return cached.folderId;
    }
    // Folder gone — clear cache and re-create
    await chrome.storage.local.remove(['folderId', 'folderLink']);
  }

  // Search for existing folder
  const query = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const listRes = await driveRequest(
    `${DRIVE_API}/files?q=${query}&fields=files(id,webViewLink)`,
    { method: 'GET' },
    token
  );
  const listData = await listRes.json();

  if (listData.files && listData.files.length > 0) {
    const { id, webViewLink } = listData.files[0];
    await chrome.storage.local.set({ folderId: id, folderLink: webViewLink });
    return id;
  }

  // Create folder
  const createRes = await driveRequest(
    `${DRIVE_API}/files?fields=id,webViewLink`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    },
    token
  );
  const folder = await createRes.json();
  await chrome.storage.local.set({ folderId: folder.id, folderLink: folder.webViewLink });
  return folder.id;
}

// ---------------------------------------------------------------------------
// Markdown builder
// ---------------------------------------------------------------------------

function buildMarkdown(messages, url) {
  const now = new Date();
  const dateStr = now.toISOString().replace('T', ' ').slice(0, 16);

  const lines = [`# Gemini Chat — ${dateStr}`, '', `Source: ${url}`, ''];

  for (const { role, text } of messages) {
    const label = role === 'user' ? '**You:**' : '**Gemini:**';
    lines.push(label);
    lines.push('');
    lines.push(text);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function buildFileName(messages) {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const timePart = now.toTimeString().slice(0, 5).replace(':', ''); // HHMM

  const firstUser = messages.find(m => m.role === 'user');
  const snippet = firstUser
    ? firstUser.text
        .slice(0, 40)
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
    : 'chat';

  return `${datePart}_${timePart}_${snippet}.md`;
}

// ---------------------------------------------------------------------------
// Multipart upload
// ---------------------------------------------------------------------------

async function uploadFile(token, folderId, fileName, content) {
  const metadata = {
    name: fileName,
    mimeType: 'text/markdown',
    parents: [folderId],
  };

  const boundary = 'lapidary_boundary_' + Math.random().toString(36).slice(2);
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: text/markdown; charset=UTF-8',
    '',
    content,
    `--${boundary}--`,
  ].join('\r\n');

  const res = await driveRequest(
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,webViewLink`,
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
    token
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Drive upload failed (${res.status}): ${err}`);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handleSaveChat({ messages, url }) {
  if (!messages || messages.length === 0) {
    throw new Error('No messages to save.');
  }

  const token = await getToken(true);
  const folderId = await ensureFolder(token);
  const markdown = buildMarkdown(messages, url);
  const fileName = buildFileName(messages);
  const file = await uploadFile(token, folderId, fileName, markdown);

  return { ok: true, webViewLink: file.webViewLink, fileId: file.id };
}
