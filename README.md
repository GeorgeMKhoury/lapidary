# Lapidary

A Chrome extension that saves Gemini conversations to Google Drive as Markdown files or Google Docs — on demand, with a single click.

**Why:** Gemini's chat history can be turned off for privacy, but you might still want your own archive. Or maybe you have chat history enabled, but you want to keep a conversation forever. This extension lets you save any conversation yourself, to a folder only you control in Drive.

---

## How it works

- A **Save to Drive** button is injected into the Gemini UI
- Clicking it scrapes the current conversation and uploads it to a "Gemini Chats" folder in your Drive
- **Two formats supported:**
    - **Markdown (.md):** Lightweight, portable, fast.
    - **Google Doc:** Richer formatting, but slower to generate.
- Files are named `YYYY-MM-DD_HHMM_first-message-slug`
- You can toggle your preferred format in the extension popup
- The extension only has access to files it creates (`drive.file` scope) — not your broader Drive

---

## Setup

### 1. Load the extension in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked** and select the `lapidary/` directory
4. The extension will appear in your list with a generated **Extension ID** (a 32-character string like `abcdefghijklmnopabcdefghijklmnop`)

### 2. Get a Google Cloud OAuth2 client ID

This is a one-time developer setup. Your users never need to do this — they just see a normal Google sign-in prompt when they first use the extension.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project (or use an existing one)
2. Navigate to **APIs & Services → Library** and enable the **Google Drive API**
3. Navigate to **APIs & Services → Credentials** and click **Create Credentials → OAuth 2.0 Client ID**
4. Set the application type to **Chrome Extension**
5. Enter the Extension ID from step 1 into the Item ID field
6. Click **Create** and copy the generated client ID — it looks like `123456789-abc...xyz.apps.googleusercontent.com`

> **OAuth consent screen:** If prompted to configure one, set it to **External**, add your email as a test user, and add the scope `https://www.googleapis.com/auth/drive.file`. You don't need to publish it for personal use.

### . Add the client ID to the manifest

Open `manifest.json` and replace the placeholder:

```json
"oauth2": {
  "client_id": "xxxxx.apps.googleusercontent.com",
  ...
}
```

### 4. Verify it works

1. Navigate to [gemini.google.com](https://gemini.google.com) and start a conversation
2. You should see a **Save to Drive** button in the header toolbar
3. Click it — on first use, a Google sign-in/consent popup will appear asking for Drive access
4. After approving, the file is uploaded and a toast notification appears in the bottom-right corner
5. Click the toast to open the file in Drive, or click the extension icon to open the "Gemini Chats" folder

---

## File structure

```
lapidary/
├── manifest.json          — Extension config and OAuth2 block
├── src/
│   ├── content.js         — Injected into gemini.google.com; scrapes DOM, injects button
│   └── background.js      — Service worker; handles OAuth and Drive API calls
├── popup/
│   ├── popup.html         — Extension popup UI
│   └── popup.js           — Shows auth status, link to Drive folder, and format toggle
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── scripts/
    └── generate-icons.js  — Optional: generate richer icons (requires `npm install canvas`)
```

No build step required — plain JavaScript, load directly from source.

---

## Troubleshooting

### The "Save to Drive" button doesn't appear

Gemini is a single-page app and occasionally updates its DOM structure. The content script uses multiple selector strategies and logs a warning if none match. To diagnose:

1. Open DevTools on `gemini.google.com` (F12 → Console)
2. Look for a `[Lapidary]` warning message
3. Inspect the Gemini page structure and identify the current selectors for the header toolbar, user messages, and model responses
4. Update the relevant selectors in `src/content.js`

After editing, go to `chrome://extensions` and click the reload icon on the Lapidary card, then refresh the Gemini tab.

### OAuth popup doesn't appear / auth fails

- Make sure the extension ID in your Google Cloud credential matches the ID shown in `chrome://extensions`
- Make sure the OAuth consent screen has `https://www.googleapis.com/auth/drive.file` listed as an approved scope
- If you're using an External consent screen and haven't published it, make sure your Google account is listed as a test user

### No messages found / empty file saved

The DOM scraper found the page but couldn't extract conversation turns. See "button doesn't appear" above for how to find and update the selectors.
