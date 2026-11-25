// SWITCH — MAIN world content script
// Rewrites fetch / XMLHttpRequest / EventSource URLs inside the page so the
// browser requests the target directly and sends the page's real Origin header
// (e.g. https://app.example.com) instead of Origin: null from a 307 redirect.
//
// Registered dynamically (chrome.scripting) ONLY on domains that have an
// enabled HTTP rule.
(function () {
  if (window.__switchHttpHooked) return;
  window.__switchHttpHooked = true;

  const STORAGE_KEY       = '__switch_http_rules';
  const DEFER_TIMEOUT_MS  = 250;
  const LOCALHOST_HOST_RE = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1\]|::1)$/i;

  let httpRules  = [];
  let rulesReady = false;
  const waiters  = [];

  function parseHostPort(raw) {
    if (raw.startsWith('[')) {
      const close = raw.indexOf(']');
      if (close === -1) return [raw, ''];
      const host = raw.slice(0, close + 1);
      const rest = raw.slice(close + 1);
      return [host, rest.startsWith(':') ? rest.slice(1) : ''];
    }
    const idx = raw.lastIndexOf(':');
    if (idx !== -1 && raw.indexOf(':') === idx) {
      return [raw.slice(0, idx), raw.slice(idx + 1)];
    }
    return [raw, ''];
  }

  function setRules(rules) {
    httpRules  = rules;
    rulesReady = true;
    while (waiters.length) waiters.shift()();
  }

  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored !== null) { httpRules = JSON.parse(stored) || []; rulesReady = true; }
  } catch { /* ignore */ }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__switch !== 'http_rules' || !Array.isArray(d.rules)) return;
    setRules(d.rules.filter(r =>
      r && typeof r.original === 'string' && typeof r.target === 'string'));
  });

  function whenReady() {
    if (rulesReady) return Promise.resolve();
    return new Promise(resolve => {
      waiters.push(resolve);
      setTimeout(resolve, DEFER_TIMEOUT_MS);
    });
  }

  function rewrite(url) {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      for (const rule of httpRules) {
        if (!rule.original || !rule.target) continue;
        const [origHost, origPort] = parseHostPort(rule.original);
        if (parsed.hostname.toLowerCase() !== origHost.toLowerCase()) continue;
        if (origPort && parsed.port !== origPort) continue;
        const [tgtHost, tgtPort] = parseHostPort(rule.target);
        if (LOCALHOST_HOST_RE.test(tgtHost)) parsed.protocol = 'http:';
        parsed.hostname = tgtHost;
        parsed.port     = tgtPort;
        const target = parsed.toString();
        console.debug('[SWITCH] HTTP rewrite:', url, '→', target);
        return target;
      }
    } catch { /* invalid URL — leave untouched */ }
    return null;
  }

  // ── fetch ───────────────────────────────────────────────────
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    async function retarget(request, target) {
      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      return new Request(target, {
        method: request.method, headers: request.headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
        mode: request.mode, credentials: request.credentials, cache: request.cache,
        redirect: request.redirect, referrer: request.referrer, referrerPolicy: request.referrerPolicy,
        integrity: request.integrity, keepalive: request.keepalive, signal: request.signal,
      });
    }

    window.fetch = async function fetch(input, init) {
      const isRequest = typeof Request === 'function' && input instanceof Request;
      await whenReady();
      const target = rewrite(isRequest ? input.url : String(input));
      if (!target) return nativeFetch.call(this, input, init);
      return nativeFetch.call(this, isRequest ? await retarget(input, target) : target, init);
    };
  }

  // ── XMLHttpRequest ──────────────────────────────────────────
  const XHR = window.XMLHttpRequest;
  if (typeof XHR === 'function') {
    const proto = XHR.prototype;
    const nativeOpen = proto.open, nativeSend = proto.send, nativeAbort = proto.abort;
    const nativeSetHeader = proto.setRequestHeader;
    const pending  = new WeakMap();
    const deferred = new WeakSet();

    proto.open = function open(method, url, ...rest) {
      pending.delete(this);
      deferred.delete(this);
      const async = rest.length === 0 || rest[0] !== false;
      if (rulesReady || !async) {
        return nativeOpen.call(this, method, rewrite(String(url)) ?? url, ...rest);
      }
      pending.set(this, { method, url: String(url), rest, headers: [] });
      return nativeOpen.call(this, method, url, ...rest);
    };

    proto.setRequestHeader = function setRequestHeader(name, value) {
      pending.get(this)?.headers.push([name, value]);
      return nativeSetHeader.call(this, name, value);
    };

    proto.send = function send(body) {
      const p = pending.get(this);
      if (!p) return nativeSend.call(this, body);
      pending.delete(this);
      deferred.add(this);
      whenReady().then(() => {
        if (!deferred.has(this)) return;
        deferred.delete(this);
        const target = rewrite(p.url);
        if (target) {
          nativeOpen.call(this, p.method, target, ...p.rest);
          for (const [name, value] of p.headers) nativeSetHeader.call(this, name, value);
        }
        nativeSend.call(this, body);
      });
    };

    proto.abort = function abort() {
      deferred.delete(this);
      return nativeAbort.call(this);
    };
  }

  // ── EventSource ─────────────────────────────────────────────
  const NativeES = window.EventSource;
  if (typeof NativeES === 'function') {
    function SwitchEventSource(url, config) {
      if (!new.target) {
        throw new TypeError("Failed to construct 'EventSource': Please use the 'new' operator.");
      }
      const target = rewrite(String(url)) ?? url;
      return config !== undefined ? new NativeES(target, config) : new NativeES(target);
    }
    SwitchEventSource.prototype = NativeES.prototype;
    SwitchEventSource.CONNECTING = 0;
    SwitchEventSource.OPEN       = 1;
    SwitchEventSource.CLOSED     = 2;
    try { Object.defineProperty(SwitchEventSource, 'name',   { value: 'EventSource' }); } catch { /* ignore */ }
    try { Object.defineProperty(SwitchEventSource, 'length', { value: 1 }); } catch { /* ignore */ }
    window.EventSource = SwitchEventSource;
  }
})();
