# ChatGPT-TurboBoost ⚡

Speed-focused Chrome extension for long ChatGPT conversations.

It reduces UI lag by trimming conversation data early (before heavy render) and limiting visible message nodes in the DOM.

---

## ✨ Features

- **Fetch/XHR interception in MAIN world** (runs at `document_start`)
- Trims conversation payload before React mounts full thread
- Keeps only recent messages visible for smooth scrolling/typing
- Inline **Load more** button for older messages
- Live popup stats:
  - Visible messages
  - Total tracked messages
  - Booster status
- Performance mode:
  - Aggressive (`+40` fetch buffer)
  - Balanced (`+100`)
  - Conservative (`+200`)

---

## 🧠 How it works

### 1) Network-level trim (primary performance layer)
`fetchInterceptor.js` patches:
- `window.fetch`
- `XMLHttpRequest`

For ChatGPT conversation endpoints, it trims the conversation tree to the latest useful messages before app rendering.

### 2) DOM-level virtualization (fallback layer)
`content.js` tracks conversation turn nodes and hides/removes older nodes from active view, then restores in batches with **Load more**.

---

## 📦 Tech stack

- JavaScript (MV3)
- Chrome Extension APIs (`storage`, `tabs`)
- CSS + HTML popup UI

---

## 🚀 Installation (local dev)

1. Clone this repo
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select this project folder

---

## ⚙️ Default settings

- Enabled: `true`
- Message limit: `30` (or `40`, based on your current config)
- Fetch buffer: `40` (Aggressive)

> Lower limits/buffers = higher performance, less history retained in active view.

---

## 🧪 Test checklist

- Open a very large ChatGPT conversation (300+ messages)
- Verify page remains responsive while loading
- Type immediately in prompt box (no major lag)
- Streamed response should remain smooth
- Click **Load more** repeatedly and confirm no freeze
- Switch between multiple chats and verify stats reset correctly

---

## 🐞 Troubleshooting

### “Still lagging on huge chats”
- Set Message Limit to `20–30`
- Set Performance Mode to **Aggressive (+40)**
- Reload ChatGPT tab once after extension reload

### “Stats show 0/0”
- Refresh ChatGPT tab
- Ensure active tab is `chatgpt.com` or `chat.openai.com`
- Reopen popup

### “Interceptor not working”
In DevTools Console:
- check `document.documentElement.getAttribute("data-cgptv-trimmed")`
- if missing on big chat load, endpoint pattern may have changed

---

## 📁 Important files

- `manifest.json` — extension config and content script registration
- `fetchInterceptor.js` — network interception and tree trimming
- `content.js` — DOM tracking, virtualization, load-more, bridge sync
- `popup.html` / `popup.js` — controls + stats
- `styles.css` — in-page badge/load-more style

---

## 🔐 Privacy

This extension runs locally in your browser and does not send your conversation data to external servers.

---

## 📌 Roadmap

- Robust endpoint pattern fallback for API changes
- Debug panel for interception hits/misses
- Optional hard mode for low-end devices
- Better memory caps for detached node storage

---

## 📝 License

MIT