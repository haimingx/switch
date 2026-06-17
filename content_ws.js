// SWITCH — MAIN world content script
// Intercepts WebSocket construction to apply WS redirect rules.
//
// This script is registered dynamically (chrome.scripting) ONLY on domains that
// have an enabled WS pair, so window.WebSocket is never touched on other pages.
//
// First-load race (plan #1): rules arrive asynchronously from content_bridge.js
// (chrome.storage round-trip), but the page may construct a WebSocket during the
// synchronous parse of the very first HTML — before the rules land. To stay
// correct without losing native fidelity:
//   - Once rules are known (cached in sessionStorage from a prior load, or pushed
//     by the bridge), construction returns a REAL native WebSocket — full fidelity.
//   - During the brief window before the first push on a fresh tab, construction
//     returns a faithful deferred facade that connects to the resolved target as
//     soon as rules arrive (or after a short timeout, to the original URL).
(function () {
  if (window.__switchWsHooked) return;            // never double-hook
  const NativeWS = window.WebSocket;
  if (typeof NativeWS !== 'function') return;
  window.__switchWsHooked = true;

  const STORAGE_KEY      = '__switch_ws_rules';
  const DEFER_TIMEOUT_MS = 250;
  // localhost / 127.x dev servers serve plain ws:// (no local TLS cert), so a
  // wss:// original must be downgraded to ws:// — mirrors the HTTP path, which
  // forces http:// for localhost targets. Host is already port-stripped here.
  const LOCALHOST_RE = /^(127\.0\.0\.\d+|localhost)$/;

  let wsRules    = [];      // current redirect rules
  let rulesReady = false;   // have we received an authoritative rule set yet?
  const waiters  = [];      // deferred facades awaiting the first rule set

  function resolveWaiters() {
    while (waiters.length) waiters.shift()(wsRules);
  }

  function setRules(rules) {
    wsRules    = Array.isArray(rules) ? rules : [];
    rulesReady = true;
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(wsRules)); } catch { /* ignore */ }
    resolveWaiters();
  }

  // Synchronous init from sessionStorage (written by a prior load in this tab).
  // Presence of the key — even an empty array — means "rules are known".
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored !== null) { wsRules = JSON.parse(stored) || []; rulesReady = true; }
  } catch { /* ignore */ }

  // Real-time rule updates from content_bridge.js (isolated world → MAIN world).
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;                       // ignore cross-frame/foreign
    const d = e.data;
    if (!d || d.__switch !== 'ws_rules' || !Array.isArray(d.rules)) return;
    const clean = d.rules.filter(r =>
      r && typeof r.original === 'string' && typeof r.target === 'string');
    setRules(clean);
  });

  function redirect(url, rules) {
    try {
      const parsed = new URL(url);
      for (const rule of rules) {
        if (!rule.original || !rule.target) continue;
        const [origHost, origPort = ''] = rule.original.split(':');
        if (parsed.hostname !== origHost) continue;
        if (origPort && parsed.port !== origPort) continue;
        const [tgtHost, tgtPort = ''] = rule.target.split(':');
        parsed.hostname = tgtHost;
        parsed.port     = tgtPort;
        // Downgrade wss:// → ws:// for localhost/IP targets (no local TLS).
        if (LOCALHOST_RE.test(tgtHost) && parsed.protocol === 'wss:') {
          parsed.protocol = 'ws:';
        }
        console.debug('[SWITCH] WS redirect:', url, '→', parsed.toString());
        return parsed.toString();
      }
    } catch { /* invalid URL — fall through */ }
    return url;
  }

  // Re-emit a native WebSocket event on the facade (events can't be re-dispatched).
  function cloneEvent(e) {
    switch (e.type) {
      case 'message': return new MessageEvent('message', {
        data: e.data, origin: e.origin, lastEventId: e.lastEventId, source: e.source, ports: e.ports,
      });
      case 'close': return new CloseEvent('close', { code: e.code, reason: e.reason, wasClean: e.wasClean });
      default:      return new Event(e.type);   // 'open' / 'error'
    }
  }

  // Faithful WebSocket facade used only during the pre-rules window on a fresh
  // tab. Mirrors native CONNECTING semantics until the real socket is created.
  class DeferredWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      this._url        = url;
      this._protocols  = protocols;
      this._binaryType = 'blob';
      this._ws         = null;     // real socket once rules resolve
      this._closed     = false;    // close() called before connect
      this._on         = { open: null, message: null, error: null, close: null };

      const connect = (rules) => {
        if (this._connected) return;
        this._connected = true;
        if (this._closed) {
          // close() was called while still CONNECTING — fire a clean close.
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
        } catch (err) {
          // Degrade safely: surface an error+close like a failed connection.
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
        setTimeout(() => connect(wsRules), DEFER_TIMEOUT_MS);  // safety net
      }
    }

    // on* handlers routed through EventTarget so dispatchEvent triggers them too.
    _setHandler(type, fn) {
      if (this._on[type]) this.removeEventListener(type, this._on[type]);
      this._on[type] = typeof fn === 'function' ? fn : null;
      if (this._on[type]) this.addEventListener(type, this._on[type]);
    }
    get onopen()    { return this._on.open; }    set onopen(f)    { this._setHandler('open', f); }
    get onmessage() { return this._on.message; } set onmessage(f) { this._setHandler('message', f); }
    get onerror()   { return this._on.error; }   set onerror(f)   { this._setHandler('error', f); }
    get onclose()   { return this._on.close; }   set onclose(f)   { this._setHandler('close', f); }

    get url()           { return this._ws ? this._ws.url : this._url; }
    get readyState()    { return this._ws ? this._ws.readyState : (this._closed ? 3 : 0); }
    get bufferedAmount(){ return this._ws ? this._ws.bufferedAmount : 0; }
    get extensions()    { return this._ws ? this._ws.extensions : ''; }
    get protocol()      { return this._ws ? this._ws.protocol : ''; }
    get binaryType()    { return this._ws ? this._ws.binaryType : this._binaryType; }
    set binaryType(v)   { this._binaryType = v; if (this._ws) this._ws.binaryType = v; }

    send(data) {
      if (this._ws) return this._ws.send(data);
      // Native WebSocket throws when send() is called in CONNECTING state.
      throw new DOMException(
        "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.", 'InvalidStateError');
    }
    close(code, reason) {
      if (this._ws) return this._ws.close(code, reason);
      this._closed = true;
    }

    get CONNECTING() { return 0; } get OPEN()    { return 1; }
    get CLOSING()    { return 2; } get CLOSED()  { return 3; }
  }

  // Wrapper constructor installed as window.WebSocket.
  function SwitchWebSocket(url, protocols) {
    if (!new.target) {
      throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator.");
    }
    const raw = typeof url === 'string' ? url : String(url);
    if (rulesReady) {
      const target = redirect(raw, wsRules);
      // Returning a real native instance preserves full WebSocket semantics.
      return protocols !== undefined ? new NativeWS(target, protocols) : new NativeWS(target);
    }
    return new DeferredWebSocket(raw, protocols);
  }

  // Make `x instanceof WebSocket` work for both native instances and facades.
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
