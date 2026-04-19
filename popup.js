(() => {
  "use strict";
  const DEFAULTS = { enabled: true, messageLimit: 30, fetchBuffer: 40 };
  const $ = id => document.getElementById(id);

  /* ── Status Pill ── */
  function status(t, live) {
    $("pillText").textContent = t;
    $("pill").classList.toggle("live", !!live);
  }

  /* ── Range Slider Fill ── */
  function updateSliderFill() {
    const el = $("msgLimit");
    const min = Number(el.min) || 10;
    const max = Number(el.max) || 100;
    const val = Number(el.value) || 30;
    const pct = ((val - min) / (max - min)) * 100;
    el.style.backgroundSize = `${pct}% 100%`;
  }

  /* ── Segmented Control ── */
  function updateSegHint(v) {
    const hint = $("segHint");
    if (!hint) return;
    if (v === 40) hint.textContent = "40+ messages load";
    else if (v === 100) hint.textContent = "100+ messages load";
    else if (v === 200) hint.textContent = "200+ messages load";
    else hint.textContent = `${v}+ messages load`;
  }

  function initSeg() {
    const seg = $("seg");
    const chip = $("segChip");
    const opts = seg.querySelectorAll(".seg-opt");
    function positionChip(opt) {
      chip.style.left = opt.offsetLeft + "px";
      chip.style.width = opt.offsetWidth + "px";
      const val = Number(opt.dataset.v);
      updateSegHint(val);
    }
    opts.forEach(o => {
      o.addEventListener("click", () => {
        opts.forEach(x => x.classList.remove("active"));
        o.classList.add("active");
        positionChip(o);
        
        // Auto-update message limit
        const v = Number(o.dataset.v);
        let limit = v;
        if (limit > 100) limit = 100; // max slider limit
        $("msgLimit").value = limit;
        $("limVal").textContent = limit;
        updateSliderFill();

        commit();
      });
    });
    // Initial position after layout
    requestAnimationFrame(() => {
      const active = seg.querySelector(".seg-opt.active");
      if (active) positionChip(active);
    });
  }

  function setSegValue(val) {
    const seg = $("seg");
    const chip = $("segChip");
    const opts = seg.querySelectorAll(".seg-opt");
    const v = String(val);
    opts.forEach(o => {
      const isActive = o.dataset.v === v;
      o.classList.toggle("active", isActive);
      if (isActive) {
        requestAnimationFrame(() => {
          chip.style.left = o.offsetLeft + "px";
          chip.style.width = o.offsetWidth + "px";
          updateSegHint(Number(v));
        });
      }
    });
  }

  function getSegValue() {
    const active = $("seg").querySelector(".seg-opt.active");
    return Number(active?.dataset.v || 40);
  }

  /* ── UI ── */
  function applyUI(c) {
    $("enabled").checked = !!c.enabled;
    $("msgLimit").value = Number(c.messageLimit);
    $("limVal").textContent = String(c.messageLimit);
    updateSliderFill();
    setSegValue(c.fetchBuffer || 40);
  }

  function readUI() {
    return {
      enabled: $("enabled").checked,
      messageLimit: Number($("msgLimit").value),
      fetchBuffer: getSegValue(),
    };
  }

  /* ── Chrome API ── */
  async function getTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const t = tabs?.[0];
    if (!t?.id || !t.url) return null;
    return (t.url.startsWith("https://chatgpt.com/") || t.url.startsWith("https://chat.openai.com/")) ? t : null;
  }

  async function ping(id) {
    try { return !!(await chrome.tabs.sendMessage(id, { type: "CGPTV_PING" }))?.ok; }
    catch { return false; }
  }

  function renderStats(s, c) {
    const v = Number(s?.renderedMessages ?? 0);
    const t = Number(s?.totalMessages ?? 0);
    const on = typeof s?.isEnabled === "boolean" ? s.isEnabled : !!c.enabled;
    $("sVis").textContent = String(v);
    $("sTot").textContent = String(t);
    $("sSt").textContent = on ? "Active" : "Off";
    $("sSt").classList.toggle("off", !on);
  }

  async function refresh() {
    const tab = await getTab();
    if (!tab) { renderStats({}, DEFAULTS); status("Open ChatGPT tab"); return; }
    if (!(await ping(tab.id))) { renderStats({}, readUI()); status("Refresh tab"); return; }
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: "CGPTV_GET_STATS" });
      if (r?.ok && r.stats) { renderStats(r.stats, readUI()); status("Connected", true); }
      else status("Unavailable");
    } catch { status("Disconnected"); }
  }

  async function broadcast(p) {
    const tab = await getTab();
    if (tab) try { await chrome.tabs.sendMessage(tab.id, { type: "CGPTV_UPDATE_SETTINGS", payload: p }); } catch {}
  }

  function save(p) { return new Promise(r => chrome.storage.sync.set(p, r)); }

  let dt = null;
  function debSave() {
    clearTimeout(dt);
    dt = setTimeout(async () => { const p = readUI(); await save(p); await broadcast(p); await refresh(); }, 200);
  }

  async function commit() {
    const p = readUI(); await save(p); await broadcast(p); await refresh();
  }

  function bind() {
    $("enabled").addEventListener("change", commit);
    $("msgLimit").addEventListener("input", () => {
      $("limVal").textContent = $("msgLimit").value;
      updateSliderFill();
      debSave();
    });
  }

  async function init() {
    const c = await new Promise(r =>
      chrome.storage.sync.get(DEFAULTS, res => r({ ...DEFAULTS, ...(res || {}) }))
    );
    applyUI(c);
    initSeg();
    bind();
    await refresh();
  }

  init();
})();
