(() => {
  "use strict";

  /* ── Config ── */
  const DEFAULT_LIMIT = 30;
  const LOAD_BATCH = 20;
  const BTN_ID = "cgptv-load-more";
  const BADGE_ID = "cgptv-indicator";

  /* ── State ── */
  let enabled = true;
  let limit = DEFAULT_LIMIT;
  let effectiveLimit = DEFAULT_LIMIT;
  let root = null;
  let detached = [];
  let observer = null;
  let trimming = false;
  let dying = false;
  let lastUrl = location.href;

  /* ══════════════════════════════════════════════════════════
     EARLY CSS — injected at document_start, before ChatGPT
     paints a single message. Hides all but last N turns via
     a pure CSS selector — zero JavaScript needed at this stage.
     ══════════════════════════════════════════════════════════ */
  const hideStyle = document.createElement("style");
  hideStyle.id = "cgptv-hide";
  hideStyle.textContent =
    `[data-testid^="conversation-turn"]:nth-last-child(n+${DEFAULT_LIMIT + 1} of [data-testid^="conversation-turn"]){display:none!important}`;
  (document.head || document.documentElement).appendChild(hideStyle);

  /* ── DOM helpers ── */
  function findRoot() {
    return document.querySelector('[data-testid="conversation-turn-list"]')
        || document.querySelector("main")
        || null;
  }

  function findTurns() {
    if (!root) return [];
    let n = root.querySelectorAll(':scope > [data-testid^="conversation-turn"]');
    if (n.length >= 2) return Array.from(n);
    n = root.querySelectorAll('[data-testid^="conversation-turn"]');
    if (n.length >= 2) return Array.from(n);
    n = root.querySelectorAll("article");
    return Array.from(n);
  }

  /* ══════════════════════════════════════════════════════════
     TRIM — the only thing that matters. Remove old messages
     from the DOM so the browser never has to render them.
     ══════════════════════════════════════════════════════════ */
  function trim() {
    if (dying || trimming || !enabled || !root) return;
    const turns = findTurns();
    const excess = turns.length - effectiveLimit;
    if (excess <= 0) return;

    trimming = true;
    for (let i = 0; i < excess; i++) {
      if (turns[i].isConnected) {
        detached.push(turns[i]);
        turns[i].remove();
      }
    }
    trimming = false;
    syncButton();
    syncBadge();
  }

  /* ══════════════════════════════════════════════════════════
     "Load N previous messages" — placed INSIDE the conversation,
     at the top of visible messages. Exactly like the reference.
     ══════════════════════════════════════════════════════════ */
  function syncButton() {
    let btn = document.getElementById(BTN_ID);
    if (!enabled || detached.length === 0) { btn?.remove(); return; }

    if (!btn) {
      btn = document.createElement("div");
      btn.id = BTN_ID;
      btn.addEventListener("click", loadMore);
    }

    const count = Math.min(LOAD_BATCH, detached.length);
    btn.textContent = `Load ${count} previous messages (configure amount in extension settings)`;

    // Place inside conversation, before the first visible turn.
    if (root && !btn.isConnected) {
      const first = findTurns()[0];
      if (first) root.insertBefore(btn, first);
      else root.prepend(btn);
    }
  }

  function loadMore() {
    if (!root || !detached.length) return;
    const take = Math.min(LOAD_BATCH, detached.length);
    effectiveLimit += take;

    // Pause observer so our insertions don't trigger re-trim.
    disconnectObs();

    const batch = detached.splice(detached.length - take, take);
    const frag = document.createDocumentFragment();
    for (const n of batch) frag.appendChild(n);

    const btn = document.getElementById(BTN_ID);
    const firstTurn = findTurns()[0];
    const ref = btn || firstTurn;
    if (ref) root.insertBefore(frag, ref);
    else root.appendChild(frag);

    connectObs();
    syncButton();
    syncBadge();
  }

  /* ── Badge (bottom-right) ── */
  function syncBadge() {
    let el = document.getElementById(BADGE_ID);
    if (!el && document.body) {
      el = document.createElement("div");
      el.id = BADGE_ID;
      document.body.appendChild(el);
    }
    if (!el) return;
    const v = findTurns().length;
    const t = v + detached.length;
    el.textContent = enabled ? `⚡ ${v} / ${t}` : "Off";
  }

  /* ── Observer (ONLY on conversation root, childList only) ── */
  function connectObs() {
    if (observer || !root) return;
    observer = new MutationObserver(() => {
      if (!trimming && !dying) trim();
    });
    observer.observe(root, { childList: true, subtree: false });
  }

  function disconnectObs() {
    observer?.disconnect();
    observer = null;
  }

  /* ══════════════════════════════════════════════════════════
     ROOT DETECTION — simple 150ms poll. Much lighter than a
     subtree MutationObserver during ChatGPT's heavy page load.
     ══════════════════════════════════════════════════════════ */
  function onRootFound(r) {
    root = r;
    trim();                     // Remove excess — synchronous, fast.
    hideStyle?.remove();        // CSS no longer needed.
    connectObs();               // Watch for new messages.
    syncButton();
    syncBadge();
  }

  const pollId = setInterval(() => {
    if (dying) { clearInterval(pollId); return; }
    const r = findRoot();
    if (r && r !== root) onRootFound(r);
  }, 150);

  /* ── Navigation (ChatGPT SPA) ── */
  const navId = setInterval(() => {
    if (dying) { clearInterval(navId); return; }
    const urlChanged = location.href !== lastUrl;
    const rootGone = root && !root.isConnected;
    if (!urlChanged && !rootGone) return;

    lastUrl = location.href;
    detached = [];
    root = null;
    effectiveLimit = limit;
    disconnectObs();
    document.getElementById(BTN_ID)?.remove();

    // Re-inject early CSS for the new conversation.
    if (enabled && !document.getElementById("cgptv-hide")) {
      const s = document.createElement("style");
      s.id = "cgptv-hide";
      s.textContent =
        `[data-testid^="conversation-turn"]:nth-last-child(n+${limit + 1} of [data-testid^="conversation-turn"]){display:none!important}`;
      (document.head || document.documentElement).appendChild(s);
    }
  }, 400);

  /* ── Settings ── */
  try {
    chrome.storage.sync.get({ enabled: true, messageLimit: DEFAULT_LIMIT }, (res) => {
      if (chrome.runtime?.lastError) return;
      enabled = res.enabled !== false;
      limit = Math.max(10, Math.min(100, Number(res.messageLimit) || DEFAULT_LIMIT));
      effectiveLimit = limit;
      if (!enabled) hideStyle?.remove();
      else {
        hideStyle.textContent =
          `[data-testid^="conversation-turn"]:nth-last-child(n+${limit + 1} of [data-testid^="conversation-turn"]){display:none!important}`;
      }
    });
  } catch {}

  try {
    chrome.runtime.onMessage.addListener((msg, _, reply) => {
      if (!msg?.type) return false;

      if (msg.type === "CGPTV_PING") {
        reply?.({ ok: true });
        return true;
      }

      if (msg.type === "CGPTV_UPDATE_SETTINGS") {
        const p = msg.payload || {};
        enabled = p.enabled !== false;
        limit = Math.max(10, Math.min(100, Number(p.messageLimit) || DEFAULT_LIMIT));
        effectiveLimit = limit;

        if (!enabled) {
          // Restore everything.
          document.getElementById("cgptv-hide")?.remove();
          if (root && detached.length) {
            disconnectObs();
            const frag = document.createDocumentFragment();
            for (const n of detached) frag.appendChild(n);
            root.prepend(frag);
            detached = [];
            connectObs();
          }
        } else {
          trim();
        }
        syncButton();
        syncBadge();
        reply?.({ ok: true });
        return true;
      }

      if (msg.type === "CGPTV_GET_STATS") {
        const v = findTurns().length;
        reply?.({
          ok: true,
          stats: {
            totalMessages: v + detached.length,
            renderedMessages: v,
            isEnabled: enabled
          }
        });
        return true;
      }

      return false;
    });
  } catch {}

  /* ── Cleanup ── */
  window.addEventListener("pagehide", () => {
    dying = true;
    clearInterval(pollId);
    clearInterval(navId);
    disconnectObs();
    document.getElementById("cgptv-hide")?.remove();
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(BADGE_ID)?.remove();
  }, { once: true });

})();