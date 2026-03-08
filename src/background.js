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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from our own extension
  if (sender.id !== chrome.runtime.id) return;

  if (msg.action === 'saveChat') {
    handleSaveChat(msg).then(sendResponse).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true; // keep channel open for async response
  }

  if (msg.action === 'signIn') {
    getToken(true)
      .then(() => getStatus())
      .then(sendResponse)
      .catch(() => sendResponse({ signedIn: false }));
    return true;
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
    if (!res.ok) return { signedIn: false };

    const info = await res.json();
    if (!info.email) return { signedIn: false };

    const { folderId, folderLink } = await chrome.storage.local.get(['folderId', 'folderLink']);
    return { signedIn: true, email: info.email, folderId, folderLink };
  } catch {
    return { signedIn: false };
  }
}

async function signOut() {
  const { token } = await new Promise(resolve =>
    chrome.identity.getAuthToken({ interactive: false }, t => {
      void chrome.runtime.lastError; // suppress unchecked lastError warning
      resolve({ token: t });
    })
  );
  if (token) {
    // Revoke the token at Google so it's fully invalidated, not just cache-cleared
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: 'POST' });
    } catch {
      // Revocation failure is non-fatal — still clear locally
    }
    await new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
  }
  await chrome.storage.local.remove(['folderId', 'folderLink']);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Drive helpers
// ---------------------------------------------------------------------------

// Guard against concurrent ensureFolder calls creating duplicate Drive folders
let _ensureFolderInFlight = null;

async function driveRequest(url, options, token, isRetry = false) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status === 401 && !isRetry) {
    // Token expired — remove and retry once with a fresh token
    await new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
    const newToken = await getToken(true);
    return driveRequest(url, options, newToken, true);
  }

  return res;
}

async function ensureFolder(token) {
  if (_ensureFolderInFlight) return _ensureFolderInFlight;
  _ensureFolderInFlight = _doEnsureFolder(token).finally(() => {
    _ensureFolderInFlight = null;
  });
  return _ensureFolderInFlight;
}

async function _doEnsureFolder(token) {
  // Check cache first
  const cached = await chrome.storage.local.get('folderId');
  if (cached.folderId && /^[a-zA-Z0-9_-]+$/.test(cached.folderId)) {
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
  if (!listRes.ok) {
    throw new Error(`Drive folder search failed (${listRes.status})`);
  }
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
  if (!createRes.ok) {
    throw new Error(`Drive folder creation failed (${createRes.status})`);
  }
  const folder = await createRes.json();
  await chrome.storage.local.set({ folderId: folder.id, folderLink: folder.webViewLink });
  return folder.id;
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Markdown builder
// ---------------------------------------------------------------------------

function buildMarkdown(messages, url, sources) {
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

  if (sources && sources.length > 0) {
    lines.push('## Sources');
    lines.push('');
    sources.forEach(({ title, siteName, url: sourceUrl }, i) => {
      const label = title || siteName || sourceUrl;
      lines.push(`${i + 1}. [${label}](${sourceUrl})`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

function buildHtml(messages, url, sources) {
  const now = new Date();
  const dateStr = now.toISOString().replace('T', ' ').slice(0, 16);

  const parts = [
    '<html><body>',
    `<h1>Gemini Chat \u2014 ${esc(dateStr)}</h1>`,
    `<p><a href="${esc(url)}">${esc(url)}</a></p>`,
  ];

  for (const { role, html } of messages) {
    const heading = role === 'user' ? 'You' : 'Gemini';
    parts.push(`<h2>${heading}</h2>`);
    parts.push(html);
  }

  if (sources && sources.length > 0) {
    parts.push('<h2>Sources</h2><ol>');
    for (const { title, siteName, url: sourceUrl } of sources) {
      const label = esc(title || siteName || sourceUrl);
      parts.push(`<li><a href="${esc(sourceUrl)}">${label}</a></li>`);
    }
    parts.push('</ol>');
  }

  parts.push('</body></html>');
  return parts.join('\n');
}

function buildFileName(messages, title, format) {
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const timePart = now.toTimeString().slice(0, 5).replace(':', ''); // HHMM

  const raw = title || messages.find(m => m.role === 'user')?.text || 'chat';
  const slug = raw
    .slice(0, 60)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

  const base = `${datePart}_${timePart}_${slug || 'chat'}`;
  return format === 'markdown' ? `${base}.md` : base;
}

// ---------------------------------------------------------------------------
// Multipart upload
// ---------------------------------------------------------------------------

async function uploadFile(token, folderId, fileName, content, format) {
  const isDoc = format === 'googledoc';
  const metadata = {
    name: fileName,
    mimeType: isDoc ? 'application/vnd.google-apps.document' : 'text/markdown',
    parents: [folderId],
  };
  const contentType = isDoc ? 'text/html' : 'text/markdown';

  // Generate a boundary that doesn't appear in the content
  let boundary;
  do {
    boundary = 'lapidary_' + crypto.randomUUID().replace(/-/g, '');
  } while (content.includes(boundary));

  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${contentType}; charset=UTF-8`,
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

async function handleSaveChat({ messages, url, sources, title }) {
  if (!messages || messages.length === 0) {
    throw new Error('No messages to save.');
  }

  const { saveFormat = 'markdown' } = await chrome.storage.sync.get({ saveFormat: 'markdown' });

  const token = await getToken(true);
  const folderId = await ensureFolder(token);
  const content = saveFormat === 'googledoc'
    ? buildHtml(messages, url, sources)
    : buildMarkdown(messages, url, sources);
  const fileName = buildFileName(messages, title, saveFormat);
  const file = await uploadFile(token, folderId, fileName, content, saveFormat);

  return { ok: true, webViewLink: file.webViewLink, fileId: file.id };
}
