(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    messageLimit: 30,
    autoOptimization: true
  };

  const $ = (id) => document.getElementById(id);

  function setFooter(text) {
    $("footerStatus").textContent = text;
  }

  function applySettingsToUI(cfg) {
    $("enabled").checked = !!cfg.enabled;
    $("messageLimit").value = Number(cfg.messageLimit);
    $("limitValue").textContent = String(cfg.messageLimit);
    $("autoOptimization").checked = !!cfg.autoOptimization;
  }

  function readSettingsFromUI() {
    return {
      enabled: $("enabled").checked,
      messageLimit: Number($("messageLimit").value),
      autoOptimization: $("autoOptimization").checked
    };
  }

  async function getActiveChatGPTTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    if (!tab?.id || !tab.url) return null;

    const isChatGPT =
      tab.url.startsWith("https://chatgpt.com/") ||
      tab.url.startsWith("https://chat.openai.com/");

    return isChatGPT ? tab : null;
  }

  async function ensureContentScript(tabId) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: "CGPTV_PING" });
      return !!pong?.ok;
    } catch {
      return false;
    }
  }

  function renderStats(stats, cfg) {
    const rendered = Number(stats?.renderedMessages ?? 0);
    const total = Number(stats?.totalMessages ?? 0);
    const enabled = typeof stats?.isEnabled === "boolean" ? stats.isEnabled : !!cfg.enabled;

    $("statVisible").textContent = String(rendered);
    $("statTotal").textContent = String(total);
    $("statStatus").textContent = enabled ? "Active" : "Off";
    $("statStatus").classList.toggle("is-off", !enabled);
  }

  async function requestLiveStats() {
    const tab = await getActiveChatGPTTab();
    if (!tab) {
      renderStats({ renderedMessages: 0, totalMessages: 0, isEnabled: false }, DEFAULTS);
      setFooter("Open ChatGPT tab for live stats");
      return;
    }

    const ready = await ensureContentScript(tab.id);
    if (!ready) {
      renderStats({ renderedMessages: 0, totalMessages: 0, isEnabled: false }, readSettingsFromUI());
      setFooter("Refresh ChatGPT tab once");
      return;
    }

    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "CGPTV_GET_STATS" });
      if (response?.ok && response.stats) {
        renderStats(response.stats, readSettingsFromUI());
        setFooter("Live data connected");
      } else {
        setFooter("Stats unavailable");
      }
    } catch {
      setFooter("Could not fetch stats");
    }
  }

  async function broadcastSettings(payload) {
    const tab = await getActiveChatGPTTab();
    if (!tab) return;

    try {
      await chrome.tabs.sendMessage(tab.id, { type: "CGPTV_UPDATE_SETTINGS", payload });
    } catch { }
  }

  function saveSettings(payload) {
    return new Promise((resolve) => chrome.storage.sync.set(payload, () => resolve()));
  }

  function debounce(fn, wait = 250) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  const debouncedSave = debounce(async () => {
    const payload = readSettingsFromUI();
    await saveSettings(payload);
    await broadcastSettings(payload);
    setFooter("Settings saved");
    await requestLiveStats();
  }, 250);

  function bindEvents() {
    ["enabled", "autoOptimization"].forEach((id) => {
      $(id).addEventListener("change", async () => {
        const payload = readSettingsFromUI();
        await saveSettings(payload);
        await broadcastSettings(payload);
        setFooter("Settings saved");
        await requestLiveStats();
      });
    });

    $("messageLimit").addEventListener("input", () => {
      $("limitValue").textContent = $("messageLimit").value;
      debouncedSave();
    });

    $("messageLimit").addEventListener("change", async () => {
      $("limitValue").textContent = $("messageLimit").value;
      const payload = readSettingsFromUI();
      await saveSettings(payload);
      await broadcastSettings(payload);
      setFooter("Settings saved");
      await requestLiveStats();
    });
  }

  async function init() {
    const cfg = await new Promise((resolve) => {
      chrome.storage.sync.get(DEFAULTS, (res) => resolve({ ...DEFAULTS, ...(res || {}) }));
    });

    applySettingsToUI(cfg);
    bindEvents();
    await requestLiveStats();
  }

  init();
})();