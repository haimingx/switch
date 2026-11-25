// SWITCH — isolated world content script
// Reads redirect rules from chrome.storage and pushes them to the MAIN world
// hooks: WS rules to content_ws.js, HTTP rules to content_http.js.
(function () {
  const CONFIG_KEY = `config.${location.hostname}`;
  const CHANNELS = [
    { message: 'ws_rules',   storageKey: '__switch_ws_rules',   isType: p => p.type === 'ws' },
    { message: 'http_rules', storageKey: '__switch_http_rules', isType: p => p.type !== 'ws' },
  ];

  function extractRules(config, isType) {
    if (!config?.isEnabled) return [];
    return (config?.pairs ?? [])
      .filter(p => p.enabled !== false && isType(p) && p.original && p.target)
      .map(p => ({ original: p.original, target: p.target }));
  }

  function pushRules(config) {
    for (const { message, storageKey, isType } of CHANNELS) {
      const rules = extractRules(config, isType);
      try { sessionStorage.setItem(storageKey, JSON.stringify(rules)); } catch { /* ignore */ }
      window.postMessage({ __switch: message, rules }, '*');
    }
  }

  chrome.storage.local.get(CONFIG_KEY, (result) => {
    pushRules(result[CONFIG_KEY]);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(CONFIG_KEY in changes)) return;
    pushRules(changes[CONFIG_KEY].newValue);
  });
})();
