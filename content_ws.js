// SWITCH — MAIN world content script
// Intercepts WebSocket construction to apply WS redirect rules.
(function () {
  const STORAGE_KEY = '__switch_ws_rules';

  // Synchronous init from sessionStorage (populated by content_bridge.js)
  let wsRules = [];
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) wsRules = JSON.parse(stored);
  } catch { /* ignore */ }

  // Real-time rule updates from content_bridge.js
  window.addEventListener('message', (e) => {
    if (e.data?.__switch !== 'ws_rules') return;
    wsRules = e.data.rules ?? [];
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(wsRules)); } catch { /* ignore */ }
  });

  function applyRules(url) {
    try {
      const parsed = new URL(url);
      for (const rule of wsRules) {
        if (!rule.original || !rule.target) continue;
        const [origHost, origPort = ''] = rule.original.split(':');
        if (parsed.hostname !== origHost) continue;
        if (origPort && parsed.port !== origPort) continue;
        const [tgtHost, tgtPort = ''] = rule.target.split(':');
        parsed.hostname = tgtHost;
        parsed.port     = tgtPort;
        console.debug('[SWITCH] WS redirect:', url, '→', parsed.toString());
        return parsed.toString();
      }
    } catch { /* invalid URL */ }
    return url;
  }

  const NativeWS = window.WebSocket;

  // Wrapper function — returns a real NativeWS instance, avoiding Web IDL subclassing issues
  function WebSocket(url, protocols) {
    const raw = typeof url === 'string' ? url : String(url);
    const redirected = applyRules(raw);
    return protocols !== undefined ? new NativeWS(redirected, protocols) : new NativeWS(redirected);
  }
  WebSocket.prototype   = NativeWS.prototype;
  WebSocket.CONNECTING  = NativeWS.CONNECTING;
  WebSocket.OPEN        = NativeWS.OPEN;
  WebSocket.CLOSING     = NativeWS.CLOSING;
  WebSocket.CLOSED      = NativeWS.CLOSED;

  window.WebSocket = WebSocket;
})();
