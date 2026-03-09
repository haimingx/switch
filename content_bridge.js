// SWITCH — isolated world content script
// Reads WS redirect rules from chrome.storage and pushes them to the MAIN world.
(function () {
  const STORAGE_KEY  = '__switch_ws_rules';
  const CONFIG_KEY   = `config.${location.hostname}`;

  function extractRules(config) {
    const enabled = config?.isEnabled ?? false;
    if (!enabled) return [];
    return (config?.pairs ?? [])
      .filter(p => p.type === 'ws' && p.original && p.target)
      .map(p => ({ original: p.original, target: p.target }));
  }

  function pushRules(rules) {
    // Write to sessionStorage so content_ws.js can read synchronously on next navigation
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(rules)); } catch { /* ignore */ }
    // postMessage for immediate MAIN world update
    window.postMessage({ __switch: 'ws_rules', rules }, '*');
  }

  // Push rules as soon as storage is read (happens before most page scripts)
  chrome.storage.local.get(CONFIG_KEY, (result) => {
    pushRules(extractRules(result[CONFIG_KEY]));
  });

  // Re-push on config change (user edits rules or toggles switch in popup)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(CONFIG_KEY in changes)) return;
    pushRules(extractRules(changes[CONFIG_KEY].newValue));
  });
})();
