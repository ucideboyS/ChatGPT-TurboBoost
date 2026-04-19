(() => {
  "use strict";

  const LIMIT = 30, BATCH = 20;
  const HIDE = "cgptv-hidden", BTN = "cgptv-load-more", BADGE = "cgptv-indicator";
  const BRIDGE = "cgptv_settings";
  const SELS = [
    'section[data-testid^="conversation-turn-"]',
    '[data-testid^="conversation-turn-"]',
    'article',
  ];

  let enabled = true, limit = LIMIT, fetchBuffer = 40;
  let root = null, obs = null, dying = false, pollId = null;
  let visCount = 0, totCount = 0, cachedVis = 0;
  let historyPatched = false;
  let activeSel = SELS[0];

  const tracked = [], elMap = new Map();

  /* ── Hide class ── */
  const sty = document.createElement("style");
  sty.textContent = `.${HIDE}{display:none!important}`;
  (document.head || document.documentElement).appendChild(sty);

  /* ── Bridge settings to MAIN world ── */
  function bridge() {
    try { localStorage.setItem(BRIDGE, JSON.stringify({ enabled, messageLimit: limit, fetchBuffer })); } catch {}
  }
  bridge();

  /* ── Selector fallback ── */
  function resolveSelector() {
    for (const sel of SELS) {
      if (document.querySelector(sel)) { activeSel = sel; return; }
    }
  }

  function findRoot() {
    resolveSelector();
    const t = document.querySelector(activeSel);
    if (!t) return document.querySelector("main") || null;
    // Walk up to find the actual list container (may be nested)
    let parent = t.parentElement;
    if (parent) return parent;
    return document.querySelector("main") || null;
  }

  function findTurns() {
    if (!root) return [];
    // Try direct children first
    let nodes = Array.from(root.querySelectorAll(":scope > " + activeSel));
    // If nothing found as direct children, search deeper
    if (nodes.length === 0) {
      nodes = Array.from(root.querySelectorAll(activeSel));
    }
    return nodes;
  }

  /* ── Tracking ── */
  function track(el) {
    if (elMap.has(el)) return;
    const m = { el, vis: true, id: el.getAttribute("data-testid") || `m${tracked.length}` };
    tracked.push(m); elMap.set(el, m);
  }
  function hide(m) { if (!m.vis) return; m.vis = false; m.el.classList.add(HIDE); }
  function show(m) { if (m.vis) return; m.vis = true; m.el.classList.remove(HIDE); }

  /* ── recalc uses `limit` directly ── */
  function recalc() {
    if (!enabled) { for (const m of tracked) show(m); counts(); return; }
    const lim = Math.max(cachedVis, limit);
    const n = tracked.length;
    for (let i = 0; i < n; i++) i < n - lim ? hide(tracked[i]) : show(tracked[i]);
    counts();
  }

  function counts() {
    visCount = 0;
    for (const m of tracked) if (m.vis) visCount++;
    totCount = tracked.length;
  }

  function initTurns(els) {
    tracked.length = 0; elMap.clear(); cachedVis = 0;
    for (const el of els) track(el);
    recalc();
  }

  /* ── Load More button — placed BEFORE root so React can't remove it ── */
  function syncBtn() {
    let b = document.getElementById(BTN);
    const hid = totCount - visCount;

    if (!enabled || hid <= 0) {
      if (b) b.style.display = "none";
      return;
    }

    if (!b) {
      b = document.createElement("div");
      b.id = BTN;
      b.addEventListener("click", loadMore);
      // Insert BEFORE root (outside React's container) so React can't remove it
      if (root && root.parentElement) {
        root.parentElement.insertBefore(b, root);
      } else if (document.body) {
        document.body.appendChild(b);
      }
    }

    b.style.display = "";
    b.textContent = `Load ${Math.min(BATCH, hid)} previous messages (configure in extension settings)`;

    // If button got disconnected (React re-rendered parent), re-insert
    if (!b.isConnected) {
      if (root && root.parentElement) {
        root.parentElement.insertBefore(b, root);
      }
    }
  }

  /* ── Load More — micro-batch 8 nodes/frame ── */
  function loadMore() {
    const hidden = tracked.filter(m => !m.vis);
    const toReveal = hidden.slice(-BATCH);
    if (!toReveal.length) return;
    let idx = 0;
    function tick() {
      const end = Math.min(idx + 8, toReveal.length);
      for (; idx < end; idx++) show(toReveal[idx]);
      counts(); syncBadge();
      if (idx < toReveal.length) requestAnimationFrame(tick);
      else { cachedVis = visCount; syncBtn(); syncBadge(); }
    }
    requestAnimationFrame(tick);
  }

  /* ── Badge — always visible, always fresh ── */
  function syncBadge() {
    let el = document.getElementById(BADGE);
    if (!el && document.body) {
      el = document.createElement("div");
      el.id = BADGE;
      document.body.appendChild(el);
    }
    if (!el) return;

    // If badge was removed from DOM, re-insert
    if (!el.isConnected && document.body) {
      document.body.appendChild(el);
    }

    el.textContent = enabled ? `⚡ ${visCount} / ${totCount}` : "Off";
  }

  /* ── Observer — scoped ── */
  function connectObs() {
    if (obs || !root) return;
    obs = new MutationObserver(muts => {
      if (dying) return;
      let ch = false;
      for (const mu of muts) {
        for (const n of mu.addedNodes)
          if (n.nodeType === 1 && n.matches?.(activeSel)) { track(n); ch = true; }
        for (const n of mu.removedNodes)
          if (n.nodeType === 1 && elMap.has(n)) {
            const i = tracked.findIndex(m => m.el === n);
            if (i >= 0) tracked.splice(i, 1);
            elMap.delete(n); ch = true;
          }
      }
      if (ch) { recalc(); syncBtn(); syncBadge(); }
    });
    // Watch both direct children and subtree for deeper nesting
    obs.observe(root, { childList: true, subtree: true });
  }
  function disconnectObs() { obs?.disconnect(); obs = null; }

  /* ── Root found ── */
  function onRoot(r) {
    root = r;
    const turns = findTurns();
    initTurns(turns);
    connectObs();
    syncBtn();
    syncBadge();
    // Stop fast poll, switch to slow periodic sync
    if (pollId) { clearInterval(pollId); pollId = null; }
  }

  // Fast poll to find root
  pollId = setInterval(() => {
    if (dying) { clearInterval(pollId); pollId = null; return; }
    const r = findRoot();
    if (r && r !== root) onRoot(r);
  }, 120);

  /* ── PERIODIC SYNC — keeps badge + button alive even if observer doesn't fire ── */
  setInterval(() => {
    if (dying || document.hidden) return;

    // Re-check root
    if (!root || !root.isConnected) {
      onNav();
      return;
    }

    // Re-scan turns in case we missed some
    const turns = findTurns();
    let changed = false;
    for (const el of turns) {
      if (!elMap.has(el)) { track(el); changed = true; }
    }
    if (changed) recalc();

    // Always refresh badge and button
    syncBadge();
    syncBtn();
  }, 2000);

  /* ── Navigation — History API hooks ── */
  function onNav() {
    root = null; tracked.length = 0; elMap.clear(); cachedVis = 0;
    disconnectObs();
    const btn = document.getElementById(BTN);
    if (btn) btn.style.display = "none";
    // Restart fast poll to find new root
    if (!pollId && !dying) {
      pollId = setInterval(() => {
        if (dying) { clearInterval(pollId); pollId = null; return; }
        const r = findRoot();
        if (r && r !== root) onRoot(r);
      }, 120);
    }
  }

  if (!historyPatched) {
    historyPatched = true;
    const _push = history.pushState, _repl = history.replaceState;
    history.pushState = function () { _push.apply(this, arguments); onNav(); };
    history.replaceState = function () { _repl.apply(this, arguments); onNav(); };
    window.addEventListener("popstate", onNav);
  }

  /* ── Settings ── */
  try {
    chrome.storage.sync.get({ enabled: true, messageLimit: LIMIT, fetchBuffer: 40 }, r => {
      if (chrome.runtime?.lastError) return;
      enabled = r.enabled !== false;
      limit = Math.max(10, Math.min(100, Number(r.messageLimit) || LIMIT));
      fetchBuffer = Number(r.fetchBuffer) || 40;
      bridge();
      if (root) { recalc(); syncBtn(); syncBadge(); }
    });
  } catch {}

  try {
    chrome.runtime.onMessage.addListener((msg, _, reply) => {
      if (!msg?.type) return false;
      if (msg.type === "CGPTV_PING") { reply?.({ ok: true }); return true; }
      if (msg.type === "CGPTV_UPDATE_SETTINGS") {
        const p = msg.payload || {};
        enabled = p.enabled !== false;
        limit = Math.max(10, Math.min(100, Number(p.messageLimit) || LIMIT));
        fetchBuffer = Number(p.fetchBuffer) || 40;
        cachedVis = 0;
        bridge(); recalc(); syncBtn(); syncBadge();
        reply?.({ ok: true }); return true;
      }
      if (msg.type === "CGPTV_GET_STATS") {
        reply?.({ ok: true, stats: { totalMessages: totCount, renderedMessages: visCount, isEnabled: enabled } });
        return true;
      }
      return false;
    });
  } catch {}

  window.addEventListener("pagehide", () => {
    dying = true;
    if (pollId) clearInterval(pollId);
    disconnectObs();
    document.getElementById(BTN)?.remove();
    document.getElementById(BADGE)?.remove();
  }, { once: true });
})();