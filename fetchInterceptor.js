(function () {
  if (window.__CGPTV_FETCH_PATCHED__) return;
  window.__CGPTV_FETCH_PATCHED__ = true;

  const BRIDGE_KEY = "cgptv_settings";
  const TRIMMED_ATTR = "data-cgptv-trimmed";
  const BYPASS_KEY = "cgptv_skip_trim_once";

  const URL_MATCH = "/backend-api/conversation/";
  const URL_EXCLUDE = ["/backend-api/conversations"];

  const originalFetch = window.fetch;

  function readSettings() {
    try {
      const raw = localStorage.getItem(BRIDGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return { enabled: true, messageLimit: 30 };
  }

  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input?.url || "";

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

    if (method !== "GET" || !url.includes(URL_MATCH)) {
      return originalFetch.call(this, input, init);
    }
    if (URL_EXCLUDE.some((ex) => url.includes(ex))) {
      return originalFetch.call(this, input, init);
    }

    const settings = readSettings();
    if (!settings.enabled) return originalFetch.call(this, input, init);

    if (localStorage.getItem(BYPASS_KEY) === "true") {
      localStorage.removeItem(BYPASS_KEY);
      document.documentElement.removeAttribute(TRIMMED_ATTR);
      return originalFetch.call(this, input, init);
    }

    const limit = Math.max(10, Number(settings.messageLimit) || 30);
    const fetchLimit = Math.min(160, limit + 60);

    const response = await originalFetch.call(this, input, init);
    if (!response.ok) return response;

    try {
      const clone = response.clone();
      let text = await clone.text();
      if (!text) return response;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

      const data = JSON.parse(text);
      const trimmed = trimConversation(data, fetchLimit);
      if (!trimmed) return response;

      document.documentElement.setAttribute(TRIMMED_ATTR, "true");

      const body = JSON.stringify(trimmed);
      const headers = new Headers(response.headers);
      headers.set("content-type", "application/json; charset=utf-8");
      headers.delete("content-length");
      headers.delete("content-encoding");

      const out = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
      Object.defineProperty(out, "url", { value: response.url });
      return out;
    } catch {
      return response;
    }
  };

  function trimConversation(data, limit) {
    const mapping = data?.mapping;
    const currentNodeId = data?.current_node;
    if (!mapping || !currentNodeId || !mapping[currentNodeId]) return null;

    const chain = [];
    const seen = new Set();
    let nid = currentNodeId;

    while (nid && mapping[nid] && !seen.has(nid)) {
      seen.add(nid);
      chain.push(nid);
      nid = mapping[nid].parent ?? null;
    }
    chain.reverse();

    const visibleRoles = new Set(["user", "assistant", "tool"]);
    const isVisible = (node) => {
      const role = node?.message?.author?.role;
      return typeof role === "string" && visibleRoles.has(role);
    };

    let totalVisible = 0;
    for (const id of chain) if (isVisible(mapping[id])) totalVisible++;
    if (totalVisible <= limit) return null;

    let need = limit;
    let cutoff = 0;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (isVisible(mapping[chain[i]])) {
        need--;
        if (need <= 0) {
          cutoff = i;
          break;
        }
      }
    }

    const kept = new Set();
    for (let i = 0; i < cutoff; i++) {
      if (!isVisible(mapping[chain[i]])) kept.add(chain[i]);
    }
    for (let i = cutoff; i < chain.length; i++) kept.add(chain[i]);

    const keptChain = chain.filter((id) => kept.has(id));
    if (!keptChain.length) return null;

    const newMapping = {};
    for (let i = 0; i < keptChain.length; i++) {
      const id = keptChain[i];
      const node = JSON.parse(JSON.stringify(mapping[id]));
      node.parent = i > 0 ? keptChain[i - 1] : null;
      node.children = i < keptChain.length - 1 ? [keptChain[i + 1]] : [];
      newMapping[id] = node;
    }

    return {
      ...data,
      mapping: newMapping
    };
  }
})();