// SWITCH — MAIN world content script
// Intercepts WebSocket construction to apply WS redirect rules.
// Registered dynamically (chrome.scripting) ONLY on domains that have an
// enabled WS rule.
(function () {
  if (window.__switchWsHooked) return;
  const NativeWS = window.WebSocket;
  if (typeof NativeWS !== 'function') return;
  window.__switchWsHooked = true;

  const STORAGE_KEY       = '__switch_ws_rules';
  const DEFER_TIMEOUT_MS  = 250;
  const LOCALHOST_HOST_RE = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1\]|::1)$/i;

  let wsRules    = [];
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

  function resolveWaiters() {
    while (waiters.length) waiters.shift()(wsRules);
  }

  function setRules(rules) {
    wsRules    = Array.isArray(rules) ? rules : [];
    rulesReady = true;
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(wsRules)); } catch { /* ignore */ }
    resolveWaiters();
  }

  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored !== null) { wsRules = JSON.parse(stored) || []; rulesReady = true; }
  } catch { /* ignore */ }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__switch !== 'ws_rules' || !Array.isArray(d.rules)) return;
    setRules(d.rules.filter(r =>
      r && typeof r.original === 'string' && typeof r.target === 'string'));
  });

  function redirect(url, rules) {
    try {
      const parsed = new URL(url);
      for (const rule of rules) {
        if (!rule.original || !rule.target) continue;
        const [origHost, origPort] = parseHostPort(rule.original);
        if (parsed.hostname.toLowerCase() !== origHost.toLowerCase()) continue;
        if (origPort && parsed.port !== origPort) continue;
        const [tgtHost, tgtPort] = parseHostPort(rule.target);
        parsed.hostname = tgtHost;
        parsed.port     = tgtPort;
        if (LOCALHOST_HOST_RE.test(tgtHost) && parsed.protocol === 'wss:') {
          parsed.protocol = 'ws:';
        }
        console.debug('[SWITCH] WS redirect:', url, '→', parsed.toString());
        return parsed.toString();
      }
    } catch { /* invalid URL — fall through */ }
    return url;
  }

  function cloneEvent(e) {
    switch (e.type) {
      case 'message': return new MessageEvent('message', {
        data: e.data, origin: e.origin, lastEventId: e.lastEventId, source: e.source, ports: e.ports,
      });
      case 'close': return new CloseEvent('close', { code: e.code, reason: e.reason, wasClean: e.wasClean });
      default:      return new Event(e.type);
    }
  }

  class DeferredWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      this._url        = url;
      this._protocols  = protocols;
      this._binaryType = 'blob';
      this._ws         = null;
      this._closed     = false;
      this._on         = { open: null, message: null, error: null, close: null };

      const connect = (rules) => {
        if (this._connected) return;
        this._connected = true;
        if (this._closed) {
          queueMicrotask(() => this.dispatchEvent(
            new CloseEvent('close', { code: 1000, reason: '', wasClean: true })));
          return;
        }
        try {
          const target = redirect(url, rules);
          this._ws = protocols !== undefined ? new NativeWS(target, protocols) : new NativeWS(target);
          this._ws.binaryType = this._binaryType;
          for (const type of ['open', 'message', 'error', 'close']) {
            this._ws.addEventListener(type, (ev) => this.dispatchEvent(cloneEvent(ev)));
          }
        } catch {
          queueMicrotask(() => {
            this.dispatchEvent(new Event('error'));
            this.dispatchEvent(new CloseEvent('close', { code: 1006, reason: '', wasClean: false }));
          });
        }
      };

      if (rulesReady) {
        connect(wsRules);
      } else {
        waiters.push(connect);
        setTimeout(() => connect(wsRules), DEFER_TIMEOUT_MS);
      }
    }

    _setHandler(type, fn) {
      if (this._on[type]) this.removeEventListener(type, this._on[type]);
      this._on[type] = typeof fn === 'function' ? fn : null;
      if (this._on[type]) this.addEventListener(type, this._on[type]);
    }
    get onopen()    { return this._on.open; }    set onopen(f)    { this._setHandler('open', f); }
    get onmessage() { return this._on.message; } set onmessage(f) { this._setHandler('message', f); }
    get onerror()   { return this._on.error; }   set onerror(f)   { this._setHandler('error', f); }
    get onclose()   { return this._on.close; }   set onclose(f)   { this._setHandler('close', f); }

    get url()            { return this._ws ? this._ws.url : this._url; }
    get readyState()     { return this._ws ? this._ws.readyState : (this._closed ? 3 : 0); }
    get bufferedAmount() { return this._ws ? this._ws.bufferedAmount : 0; }
    get extensions()     { return this._ws ? this._ws.extensions : ''; }
    get protocol()       { return this._ws ? this._ws.protocol : ''; }
    get binaryType()     { return this._ws ? this._ws.binaryType : this._binaryType; }
    set binaryType(v)    { this._binaryType = v; if (this._ws) this._ws.binaryType = v; }

    send(data) {
      if (this._ws) return this._ws.send(data);
      throw new DOMException(
        "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
    }
    close(code, reason) {
      if (this._ws) return this._ws.close(code, reason);
      this._closed = true;
    }

    get CONNECTING() { return 0; }
    get OPEN()       { return 1; }
    get CLOSING()    { return 2; }
    get CLOSED()     { return 3; }
  }

  function SwitchWebSocket(url, protocols) {
    if (!new.target) {
      throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
    }
    const raw = typeof url === 'string' ? url : String(url);
    if (rulesReady) {
      const target = redirect(raw, wsRules);
      return protocols !== undefined ? new NativeWS(target, protocols) : new NativeWS(target);
    }
    return new DeferredWebSocket(raw, protocols);
  }

  Object.defineProperty(SwitchWebSocket, Symbol.hasInstance, {
    value: (inst) => inst instanceof NativeWS || inst instanceof DeferredWebSocket,
  });

  SwitchWebSocket.prototype = NativeWS.prototype;
  SwitchWebSocket.CONNECTING = 0;
  SwitchWebSocket.OPEN       = 1;
  SwitchWebSocket.CLOSING    = 2;
  SwitchWebSocket.CLOSED     = 3;
  try { Object.defineProperty(SwitchWebSocket, 'name',   { value: 'WebSocket' }); } catch { /* ignore */ }
  try { Object.defineProperty(SwitchWebSocket, 'length', { value: 1 }); } catch { /* ignore */ }

  window.WebSocket = SwitchWebSocket;
})();
