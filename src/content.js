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
// HTML → Markdown converter
// ---------------------------------------------------------------------------

/**
 * Recursively walks a DOM node and returns a Markdown string.
 * Preserves links, bold, italic, inline code, code blocks, lists,
 * and Gemini citation markers (source-footnote → [[N]](url)).
 *
 * @param {Node} node
 * @param {Array<{url:string}>} sources - ordered list from scrapeSources()
 */
function htmlToMarkdown(node, sources = []) {
  function walk(n) {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent;
    if (n.nodeType !== Node.ELEMENT_NODE) return '';

    const tag = n.tagName.toLowerCase();

    // Skip interactive UI elements injected into the response
    if (tag === 'button' || tag === 'svg' || tag === 'mat-icon') return '';

    const children = () => [...n.childNodes].map(walk).join('');

    switch (tag) {
      case 'source-footnote': {
        // Gemini's inline citation marker — data-turn-source-index is 1-based
        const sup = n.querySelector('sup[data-turn-source-index]');
        if (!sup) return '';
        const idx = parseInt(sup.getAttribute('data-turn-source-index'), 10);
        const source = sources[idx - 1];
        return source?.url ? `[[${idx}]](${source.url})` : `[${idx}]`;
      }
      case 'sup':
        // Bare <sup> inside source-footnote is handled above; skip here
        if (n.getAttribute('data-turn-source-index')) return '';
        return children();
      case 'a': {
        const href = n.getAttribute('href');
        const text = children();
        if (!href || href.startsWith('javascript:')) return text;
        const abs = href.startsWith('http') ? href : new URL(href, location.origin).href;
        return `[${text}](${abs})`;
      }
      case 'strong':
      case 'b':
        return `**${children()}**`;
      case 'em':
      case 'i':
        return `*${children()}*`;
      case 'pre': {
        // Use the <code> element if present to avoid picking up UI text
        // (e.g., copy buttons) that Gemini nests inside the <pre>.
        const code = n.querySelector('code');
        const lang = (code || n).className.match(/language-(\S+)/)?.[1] ?? '';
        const text = (code || n).textContent;
        return `\`\`\`${lang}\n${text.trimEnd()}\n\`\`\`\n\n`;
      }
      case 'code':
        return n.closest('pre') ? n.textContent : `\`${n.textContent}\``;
      case 'br':
        return '\n';
      case 'p':
        return children() + '\n\n';
      case 'h1': return `# ${children()}\n\n`;
      case 'h2': return `## ${children()}\n\n`;
      case 'h3': return `### ${children()}\n\n`;
      case 'h4': return `#### ${children()}\n\n`;
      case 'li': {
        const isOrdered = n.parentElement?.tagName.toLowerCase() === 'ol';
        if (isOrdered) {
          const idx = [...n.parentElement.children].indexOf(n) + 1;
          return `${idx}. ${children().trim()}\n`;
        }
        return `- ${children().trim()}\n`;
      }
      case 'ul':
      case 'ol':
        return children() + '\n';
      case 'hr':
        return '\n---\n\n';
      default:
        return children();
    }
  }

  return walk(node);
}

// ---------------------------------------------------------------------------
// DOM scraping
// ---------------------------------------------------------------------------

/**
 * Scrapes the Sources sidebar panel.
 * Returns an array of { title, siteName, url } — deduplicated by base URL.
 */
async function scrapeSources() {
  // If the sidebar is already open, scrape directly
  let cards = document.querySelectorAll('inline-source-card');

  // If not open but citations exist, click the <sup> marker to force the sidebar open
  if (cards.length === 0) {
    const sup = document.querySelector('sup[data-turn-source-index]');
    if (sup) {
      sup.click();

      // Poll until inline-source-card elements appear, up to 2s
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        cards = document.querySelectorAll('inline-source-card');
        if (cards.length > 0) break;
      }

      // Close the sidebar
      const closeBtn = document.querySelector('[data-test-id="close-button"]');
      if (closeBtn) closeBtn.click();
    }
  }

  const sources = [];

  // Preserve order — data-turn-source-index is 1-based into this list.
  // Do NOT deduplicate: the same base URL can appear multiple times with
  // different #:~:text= fragments pointing to different passages.
  cards.forEach(card => {
    const a = card.querySelector('a[href]');
    const title = card.querySelector('.title')?.textContent.trim() ?? '';
    const siteName = card.querySelector('.source-path')?.textContent.trim() ?? '';
    sources.push({ title, siteName, url: a ? a.href : '' });
  });

  return sources;
}

/**
 * Returns an array of { role: 'user'|'model', text: string } objects.
 * Selector priority: try several known patterns and log clearly if nothing matches.
 */
function scrapeMessages(sources) {
  const messages = [];
  const md = el => htmlToMarkdown(el, sources).trim();

  // Strategy 1: role-attributed elements (most reliable if present)
  const roleEls = document.querySelectorAll('[data-message-author-role]');
  if (roleEls.length > 0) {
    roleEls.forEach(el => {
      const role = el.getAttribute('data-message-author-role');
      messages.push({ role, text: md(el) });
    });
    return messages;
  }

  // Strategy 2: class-based selectors observed in Gemini's current build
  const turns = document.querySelectorAll('user-query, model-response, .conversation-turn');
  if (turns.length > 0) {
    turns.forEach(el => {
      const isUser = el.tagName === 'USER-QUERY' || el.classList.contains('user-turn');
      messages.push({ role: isUser ? 'user' : 'model', text: md(el) });
    });
    return messages;
  }

  // Strategy 3: fallback — find user/model elements separately and interleave by DOM order
  const userEls = document.querySelectorAll(
    '.user-query-text, .user-query-bubble-with-background, [class*="user-query"]'
  );
  const modelEls = document.querySelectorAll(
    '.model-response-text, .response-content, [class*="model-response"], [class*="response-text"]'
  );

  if (userEls.length > 0 || modelEls.length > 0) {
    const all = [
      ...[...userEls].map(el => ({ role: 'user', el })),
      ...[...modelEls].map(el => ({ role: 'model', el })),
    ].sort((a, b) => {
      const pos = a.el.compareDocumentPosition(b.el);
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    all.forEach(({ role, el }) => messages.push({ role, text: md(el) }));
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
    const sources = await scrapeSources();
    const messages = scrapeMessages(sources);
    if (messages.length === 0) {
      showToast('No messages found. The chat may be empty or Gemini updated its layout.', true);
      return;
    }

    const response = await chrome.runtime.sendMessage({
      action: 'saveChat',
      messages,
      sources,
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
