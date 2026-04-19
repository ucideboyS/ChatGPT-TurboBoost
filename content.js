(() => {
  "use strict";

  const DEFAULT_SETTINGS = {
    enabled: true,
    messageLimit: 40,
    autoOptimization: false
  };

  const BRIDGE_KEY = "cgptv_settings";
  const BYPASS_KEY = "cgptv_skip_trim_once";
  const INDICATOR_ID = "cgptv-indicator";
  const LOAD_MORE_ID = "cgptv-load-more";

  const LOAD_BATCH = 20;

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    initialized: false,
    shuttingDown: false,
    runtimeListenerAttached: false,

    observer: null,
    conversationRoot: null,
    detachedMessages: [],
    cachedVisible: 0,
    cachedTotal: 0,

    historyHooked: false,
    trimQueued: false
  };

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

  function isExtensionAlive() {
    try {
      return typeof chrome !== "undefined" && !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function injectFetchInterceptor() {
    try {
      if (document.documentElement.dataset.cgptvInterceptorInjected === "1") return;
      const src = chrome.runtime.getURL("fetchInterceptor.js");
      const s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.onload = () => s.remove();
      s.onerror = () => s.remove();
      (document.head || document.documentElement).appendChild(s);
      document.documentElement.dataset.cgptvInterceptorInjected = "1";
    } catch {}
  }

  function syncBridgeSettings() {
    try {
      localStorage.setItem(
        BRIDGE_KEY,
        JSON.stringify({
          enabled: !!state.settings.enabled,
          messageLimit: clamp(Number(state.settings.messageLimit) || 40, 10, 100)
        })
      );
    } catch {}
  }

  async function loadSettings() {
    if (!isExtensionAlive()) return;
    const cfg = await new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULT_SETTINGS, (res) => {
          if (chrome.runtime?.lastError) return resolve(DEFAULT_SETTINGS);
          resolve({ ...DEFAULT_SETTINGS, ...(res || {}) });
        });
      } catch {
        resolve(DEFAULT_SETTINGS);
      }
    });

    state.settings = { ...DEFAULT_SETTINGS, ...cfg };
    state.settings.messageLimit = clamp(Number(state.settings.messageLimit) || 40, 10, 100);
    syncBridgeSettings();
  }

  function attachRuntimeListener() {
    if (state.runtimeListenerAttached || !isExtensionAlive()) return;

    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (state.shuttingDown || !msg?.type) return false;

        if (msg.type === "CGPTV_PING") {
          sendResponse?.({ ok: true });
          return true;
        }

        if (msg.type === "CGPTV_UPDATE_SETTINGS") {
          const next = { ...state.settings, ...(msg.payload || {}) };
          next.messageLimit = clamp(Number(next.messageLimit) || 40, 10, 100);
          state.settings = next;
          syncBridgeSettings();
          queueTrim();
          sendResponse?.({ ok: true });
          return true;
        }

        if (msg.type === "CGPTV_GET_STATS") {
          sendResponse?.({
            ok: true,
            stats: {
              totalMessages: state.cachedTotal,
              renderedMessages: state.cachedVisible,
              isEnabled: !!state.settings.enabled
            }
          });
          return true;
        }

        if (msg.type === "CGPTV_LOAD_FULL_ONCE") {
          try { localStorage.setItem(BYPASS_KEY, "true"); } catch {}
          sendResponse?.({ ok: true });
          return true;
        }

        return false;
      });

      state.runtimeListenerAttached = true;
    } catch {}
  }

  function getConversationRoot() {
    return (
      document.querySelector('[data-testid="conversation-turn-list"]') ||
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      null
    );
  }

  function dedupeTop(nodes) {
    const uniq = [...new Set(nodes)].filter((n) => n && n.isConnected);
    return uniq.filter((el) => !uniq.some((other) => other !== el && other.contains(el)));
  }

  function getTurnNodes(root) {
    if (!root) return [];

    let nodes = Array.from(root.querySelectorAll(':scope > [data-testid^="conversation-turn"]'));
    if (nodes.length >= 2) return nodes;

    nodes = Array.from(root.querySelectorAll('[data-testid^="conversation-turn"]'));
    if (nodes.length >= 2) return dedupeTop(nodes);

    nodes = Array.from(root.querySelectorAll(":scope > article"));
    if (nodes.length >= 2) return nodes;

    nodes = Array.from(root.querySelectorAll("article"));
    return dedupeTop(nodes);
  }

  function updateCachedStats() {
    const root = state.conversationRoot || getConversationRoot();
    const visible = root ? getTurnNodes(root).length : 0;
    state.cachedVisible = visible;
    state.cachedTotal = visible + state.detachedMessages.length;
  }

  function ensureIndicator() {
    let el = document.getElementById(INDICATOR_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = INDICATOR_ID;
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }

  function updateIndicator() {
    updateCachedStats();
    const el = ensureIndicator();

    const trimHitTs = document.documentElement.getAttribute("data-cgptv-fetch-trim-hit");
    const trimmedRecently = trimHitTs && Date.now() - Number(trimHitTs) < 120000;

    el.textContent = state.settings.enabled
      ? `${trimmedRecently ? "⚡" : "…"} ${state.cachedVisible} / ${state.cachedTotal}`
      : `Off ${state.cachedVisible}/${state.cachedTotal}`;

    el.style.opacity = state.settings.enabled ? "1" : "0.72";
  }

  function buildLoadMoreButton() {
    const btn = document.createElement("button");
    btn.id = LOAD_MORE_ID;
    btn.type = "button";
    btn.textContent = "Load more";
    btn.addEventListener("click", () => restoreBatch(LOAD_BATCH));
    return btn;
  }

  function ensureLoadMoreButton() {
    let btn = document.getElementById(LOAD_MORE_ID);
    if (!btn) {
      btn = buildLoadMoreButton();
      (document.body || document.documentElement).appendChild(btn);
    }
    return btn;
  }

  function updateLoadMoreButton() {
    const btn = ensureLoadMoreButton();
    const hidden = state.detachedMessages.length;

    if (!state.settings.enabled || hidden <= 0) {
      btn.style.display = "none";
      return;
    }

    btn.style.display = "block";
    btn.textContent = `Load more (${hidden} hidden)`;
  }

  function restoreBatch(count) {
    const root = state.conversationRoot || getConversationRoot();
    if (!root || !state.detachedMessages.length) return;

    const take = Math.min(count, state.detachedMessages.length);
    const start = state.detachedMessages.length - take;
    const batch = state.detachedMessages.splice(start, take);

    const frag = document.createDocumentFragment();
    for (const node of batch) if (node) frag.appendChild(node);

    const firstTurn = getTurnNodes(root)[0];
    if (firstTurn) root.insertBefore(frag, firstTurn);
    else root.appendChild(frag);

    updateIndicator();
    updateLoadMoreButton();
  }

  async function trimNow() {
    state.trimQueued = false;
    if (state.shuttingDown) return;

    const root = state.conversationRoot || getConversationRoot();
    if (!root) return;

    if (!state.settings.enabled) {
      if (state.detachedMessages.length) {
        const frag = document.createDocumentFragment();
        for (const n of state.detachedMessages) if (n) frag.appendChild(n);
        const first = root.firstChild;
        if (first) root.insertBefore(frag, first);
        else root.appendChild(frag);
        state.detachedMessages = [];
      }
      updateIndicator();
      updateLoadMoreButton();
      return;
    }

    const limit = clamp(Number(state.settings.messageLimit) || 40, 10, 100);

    while (!state.shuttingDown) {
      const turns = getTurnNodes(root);
      const excess = turns.length - limit;
      if (excess <= 0) break;

      const slice = turns.slice(0, Math.min(excess, 12));
      for (const node of slice) {
        if (!node?.isConnected) continue;
        state.detachedMessages.push(node);
        node.remove();
      }

      await new Promise((r) => requestAnimationFrame(r));
    }

    updateIndicator();
    updateLoadMoreButton();
  }

  function queueTrim() {
    if (state.trimQueued || state.shuttingDown) return;
    state.trimQueued = true;
    requestAnimationFrame(() => trimNow());
  }

  function disconnectObserver() {
    try { state.observer?.disconnect(); } catch {}
    state.observer = null;
  }

  function connectObserver() {
    const root = getConversationRoot();
    if (!root) return false;

    if (state.conversationRoot === root && state.observer) return true;

    disconnectObserver();
    state.conversationRoot = root;

    state.observer = new MutationObserver((mutations) => {
      if (state.shuttingDown) return;
      for (const m of mutations) {
        if (m.type !== "childList") continue;
        if (!m.addedNodes.length && !m.removedNodes.length) continue;
        queueTrim();
        break;
      }
    });

    state.observer.observe(root, { childList: true, subtree: false });
    return true;
  }

  function hookHistoryNavigation() {
    if (state.historyHooked) return;
    state.historyHooked = true;

    const onNav = () => {
      if (state.shuttingDown) return;
      state.detachedMessages = [];
      state.conversationRoot = null;
      disconnectObserver();

      setTimeout(() => {
        if (state.shuttingDown) return;
        connectObserver();
        queueTrim();
      }, 80);
    };

    const wrap = (fn) => function (...args) {
      const out = fn.apply(this, args);
      onNav();
      return out;
    };

    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", onNav);
  }

  function cleanup() {
    state.shuttingDown = true;
    disconnectObserver();
    try { document.getElementById(INDICATOR_ID)?.remove(); } catch {}
    try { document.getElementById(LOAD_MORE_ID)?.remove(); } catch {}
  }

  async function init() {
    if (state.initialized) return;

    window.addEventListener("pagehide", cleanup, { once: true });
    window.addEventListener("beforeunload", cleanup, { once: true });

    injectFetchInterceptor();
    await loadSettings();
    if (state.shuttingDown) return;

    attachRuntimeListener();
    ensureIndicator();
    ensureLoadMoreButton();
    hookHistoryNavigation();

    const start = Date.now();
    while (!state.shuttingDown && Date.now() - start < 12000) {
      if (connectObserver()) break;
      await new Promise((r) => setTimeout(r, 80));
    }

    queueTrim();
    setTimeout(queueTrim, 120);
    setTimeout(queueTrim, 400);

    state.initialized = true;
  }

  init();
})();