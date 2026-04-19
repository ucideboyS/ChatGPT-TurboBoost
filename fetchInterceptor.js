/**
 * FETCH + XHR INTERCEPTOR — MAIN world, document_start.
 * Trims ChatGPT conversation API JSON BEFORE React sees it.
 *
 * ALL FIXES APPLIED:
 * #1 — fetchBuffer read from settings (default 40, configurable)
 * #3 — XHR interception for SSE/streaming paths
 * #4 — Cache key includes fetchBuffer + messageLimit
 */
(function () {
  if (window.__CGPTV_FETCH_PATCHED__) return;
  window.__CGPTV_FETCH_PATCHED__ = true;

  const BRIDGE = "cgptv_settings";
  const TRIMMED = "data-cgptv-trimmed";
  const BYPASS = "cgptv_skip_trim_once";
  const URL_HIT = "/backend-api/conversation/";
  const URL_SKIP = ["/backend-api/conversations"];
  const VIS_ROLES = new Set(["user", "assistant", "tool"]);

  /* ── LRU cache — key includes settings so stale data is never served (#4) ── */
  const cache = new Map();
  function cacheKey(url, limit, buf) { return `${url}|${limit}|${buf}`; }
  function cacheGet(k) { const v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); } return v; }
  function cachePut(k, v) { cache.delete(k); cache.set(k, v); if (cache.size > 5) cache.delete(cache.keys().next().value); }
  function cacheDropUrl(url) { for (const k of cache.keys()) if (k.startsWith(url + "|")) cache.delete(k); }

  function cfg() {
    try { const r = localStorage.getItem(BRIDGE); if (r) return JSON.parse(r); } catch { }
    return { enabled: true, messageLimit: 30, fetchBuffer: 40 };
  }

  function ok(url, method) {
    return method === "GET" && url.includes(URL_HIT) && !URL_SKIP.some(x => url.includes(x));
  }

  function bypassed() {
    if (localStorage.getItem(BYPASS) === "true") {
      localStorage.removeItem(BYPASS);
      document.documentElement.removeAttribute(TRIMMED);
      return true;
    }
    return false;
  }

  function computeLimit(s) {
    // #1 — Use fetchBuffer from settings (default 40)
    return s.messageLimit + (s.fetchBuffer || 40);
  }

  /* ═══ FETCH ═══ */
  const _fetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url || "";
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!ok(url, method)) return _fetch.call(this, input, init);

    const s = cfg();
    if (!s.enabled) return _fetch.call(this, input, init);
    if (bypassed()) { cacheDropUrl(url); return _fetch.call(this, input, init); }

    const lim = computeLimit(s);
    const ck = cacheKey(url, s.messageLimit, s.fetchBuffer || 40);

    // Cache hit (#4 — key includes settings)
    const hit = cacheGet(ck);
    if (hit) {
      if (hit.trimmed) document.documentElement.setAttribute(TRIMMED, "true");
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: new Headers(hit.headers) });
    }

    const res = await _fetch.call(this, input, init);
    if (!res.ok) return res;

    try {
      let text = await res.clone().text();
      if (!text) return res;
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      const data = JSON.parse(text);
      const trimmed = trim(data, lim);

      const entry = { status: res.status, statusText: res.statusText, headers: [...new Headers(res.headers)], trimmed: !!trimmed };
      entry.body = trimmed ? JSON.stringify(trimmed) : text;
      if (trimmed) document.documentElement.setAttribute(TRIMMED, "true");
      cachePut(ck, entry);
      if (!trimmed) return res;

      const h = new Headers(res.headers);
      h.set("content-type", "application/json;charset=utf-8");
      h.delete("content-length");
      h.delete("content-encoding");
      const out = new Response(entry.body, { status: res.status, statusText: res.statusText, headers: h });
      Object.defineProperty(out, "url", { value: res.url });
      return out;
    } catch { return res; }
  };

  /* ═══ XHR (#3) ═══ */
  const _xhrOpen = XMLHttpRequest.prototype.open;
  const _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._cgv_m = (method || "GET").toUpperCase();
    this._cgv_u = String(url);
    this._cgv_i = ok(this._cgv_u, this._cgv_m);
    return _xhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (!this._cgv_i) return _xhrSend.call(this, body);
    const s = cfg();
    if (!s.enabled || bypassed()) { this._cgv_i = false; return _xhrSend.call(this, body); }
    const lim = computeLimit(s);
    const xhr = this;
    const orig = xhr.onreadystatechange;
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300) {
        try {
          let t = xhr.responseText;
          if (t && t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
          const d = JSON.parse(t);
          const tr = trim(d, lim);
          if (tr) {
            document.documentElement.setAttribute(TRIMMED, "true");
            const nt = JSON.stringify(tr);
            Object.defineProperty(xhr, "responseText", { get: () => nt, configurable: true });
            Object.defineProperty(xhr, "response", { get: () => nt, configurable: true });
          }
        } catch { }
      }
      if (orig) orig.apply(this, arguments);
    };
    return _xhrSend.call(this, body);
  };

  /* ═══ TREE TRIMMER — shallow clone ═══ */
  function isV(n) { const r = n?.message?.author?.role; return typeof r === "string" && VIS_ROLES.has(r); }

  function trim(data, limit) {
    const map = data?.mapping, cur = data?.current_node;
    if (!map || !cur || !map[cur]) return null;
    const chain = []; const seen = new Set(); let nid = cur;
    while (nid && map[nid] && !seen.has(nid)) { seen.add(nid); chain.push(nid); nid = map[nid].parent ?? null; }
    chain.reverse();
    let tv = 0; for (const id of chain) if (isV(map[id])) tv++;
    if (tv <= limit) return null;
    let need = limit, cut = 0;
    for (let i = chain.length - 1; i >= 0; i--) if (isV(map[chain[i]]) && --need <= 0) { cut = i; break; }
    const kept = new Set();
    for (let i = 0; i < cut; i++) if (!isV(map[chain[i]])) kept.add(chain[i]);
    for (let i = cut; i < chain.length; i++) kept.add(chain[i]);
    const ka = chain.filter(id => kept.has(id));
    if (!ka.length) return null;
    const nm = {};
    for (let i = 0; i < ka.length; i++) {
      nm[ka[i]] = { ...map[ka[i]], parent: i > 0 ? ka[i - 1] : null, children: i < ka.length - 1 ? [ka[i + 1]] : [] };
    }
    return { ...data, mapping: nm };
  }
})();