/**
 * content.js — injected into gemini.google.com
 *
 * Responsibilities:
 *  1. Inject a "Save to Drive" button into the Gemini header toolbar.
 *  2. Re-inject the button when Gemini navigates between chats (SPA).
 *  3. On click, scrape the conversation, send to background, show toast.
 */

const BUTTON_ID = 'lapidary-save-btn';
const TOAST_ID = 'lapidary-toast';

// ---------------------------------------------------------------------------
// DOM scraping
// ---------------------------------------------------------------------------

/**
 * Returns an array of { role: 'user'|'model', text: string } objects.
 * Selector priority: try several known patterns and log clearly if nothing matches.
 */
function scrapeMessages() {
  const messages = [];

  // Each conversation turn is wrapped in a <message-content> or similar element.
  // We try multiple selector strategies so the extension degrades gracefully
  // when Gemini updates its DOM.

  // Strategy 1: role-attributed elements (most reliable if present)
  const roleEls = document.querySelectorAll('[data-message-author-role]');
  if (roleEls.length > 0) {
    roleEls.forEach(el => {
      const role = el.getAttribute('data-message-author-role'); // 'user' or 'model'
      messages.push({ role, text: el.innerText.trim() });
    });
    return messages;
  }

  // Strategy 2: class-based selectors observed in Gemini's current build
  const turns = document.querySelectorAll('user-query, model-response, .conversation-turn');
  if (turns.length > 0) {
    turns.forEach(el => {
      const isUser = el.tagName === 'USER-QUERY' || el.classList.contains('user-turn');
      messages.push({
        role: isUser ? 'user' : 'model',
        text: el.innerText.trim(),
      });
    });
    return messages;
  }

  // Strategy 3: fallback — find user query text and model response text separately
  const userEls = document.querySelectorAll(
    '.user-query-text, .user-query-bubble-with-background, [class*="user-query"]'
  );
  const modelEls = document.querySelectorAll(
    '.model-response-text, .response-content, [class*="model-response"], [class*="response-text"]'
  );

  if (userEls.length > 0 || modelEls.length > 0) {
    // Interleave by DOM order
    const all = [
      ...[...userEls].map(el => ({ role: 'user', el })),
      ...[...modelEls].map(el => ({ role: 'model', el })),
    ].sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    all.forEach(({ role, el }) => messages.push({ role, text: el.innerText.trim() }));
    return messages;
  }

  console.warn('[Lapidary] No messages found. Gemini DOM selectors may need updating.');
  return messages;
}

// ---------------------------------------------------------------------------
// Toast notification
// ---------------------------------------------------------------------------

function showToast(message, isError = false) {
  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      zIndex: '999999',
      padding: '12px 20px',
      borderRadius: '8px',
      fontSize: '14px',
      fontFamily: 'Google Sans, sans-serif',
      fontWeight: '500',
      boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
      transition: 'opacity 0.3s ease',
      maxWidth: '340px',
      lineHeight: '1.4',
    });
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.onclick = null;
  toast.style.cursor = 'default';
  toast.style.background = isError ? '#d93025' : '#1a73e8';
  toast.style.color = '#fff';
  toast.style.opacity = '1';

  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.style.opacity = '0';
  }, 4000);
}

// ---------------------------------------------------------------------------
// Button injection
// ---------------------------------------------------------------------------

function createButton() {
  const btn = document.createElement('button');
  btn.id = BUTTON_ID;
  btn.textContent = 'Save to Drive';
  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '8px 16px',
    borderRadius: '20px',
    border: 'none',
    background: '#1a73e8',
    color: '#fff',
    fontSize: '13px',
    fontFamily: 'Google Sans, sans-serif',
    fontWeight: '500',
    cursor: 'pointer',
    marginLeft: '8px',
    transition: 'background 0.2s',
  });

  btn.addEventListener('mouseenter', () => { btn.style.background = '#1557b0'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = '#1a73e8'; });

  btn.addEventListener('click', handleSave);
  return btn;
}

/**
 * Try several candidate toolbar elements to host the button.
 * Returns the container element if found, null otherwise.
 */
function findToolbar() {
  const candidates = [
    // Gemini uses Angular custom elements — no <header> or <nav>
    'top-bar-actions .right-section',   // right-side button group (preferred)
    'top-bar-actions .buttons-container', // inner button row fallback
    'top-bar-actions',                   // outermost custom element fallback
  ];

  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function injectButton() {
  if (document.getElementById(BUTTON_ID)) return; // already present

  const toolbar = findToolbar();
  if (!toolbar) return; // toolbar not ready yet

  toolbar.appendChild(createButton());
}

// ---------------------------------------------------------------------------
// Save handler
// ---------------------------------------------------------------------------

async function handleSave() {
  const btn = document.getElementById(BUTTON_ID);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving…';
  }

  try {
    const messages = scrapeMessages();
    if (messages.length === 0) {
      showToast('No messages found. The chat may be empty or Gemini updated its layout.', true);
      return;
    }

    const response = await chrome.runtime.sendMessage({
      action: 'saveChat',
      messages,
      url: location.href,
    });

    if (response && response.ok) {
      showToast(`Saved! Open in Drive ↗`);
      const toast = document.getElementById(TOAST_ID);
      if (toast && response.webViewLink) {
        toast.style.cursor = 'pointer';
        toast.onclick = () => window.open(response.webViewLink, '_blank');
      }
    } else {
      showToast(`Save failed: ${response ? response.error : 'No response from extension'}`, true);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  } finally {
    // Re-query by ID — the original btn reference may be detached if Gemini
    // navigated to a new chat while the save was in progress.
    const currentBtn = document.getElementById(BUTTON_ID);
    if (currentBtn) {
      currentBtn.disabled = false;
      currentBtn.textContent = 'Save to Drive';
    }
  }
}

// ---------------------------------------------------------------------------
// SPA navigation handling
// ---------------------------------------------------------------------------

// Attempt injection immediately and on DOM mutations (Gemini is a SPA).
function tryInject() {
  injectButton();
}

// Polling fallback for initial load
let pollInterval = setInterval(() => {
  if (document.getElementById(BUTTON_ID)) {
    clearInterval(pollInterval);
    return;
  }
  tryInject();
}, 800);

// MutationObserver to re-inject after SPA navigation removes our button.
// Debounced to avoid running findToolbar() on every DOM mutation during heavy rendering.
let _injectDebounce = null;
const observer = new MutationObserver(() => {
  if (document.getElementById(BUTTON_ID)) return;
  if (_injectDebounce) return;
  _injectDebounce = setTimeout(() => {
    _injectDebounce = null;
    tryInject();
  }, 200);
});

observer.observe(document.body, { childList: true, subtree: true });

tryInject();
