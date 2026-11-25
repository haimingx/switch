// SWITCH Service Worker — ES Module
import * as Config  from './modules/config.js';
import * as Cookies from './modules/cookies.js';
import * as Rules   from './modules/rules.js';
import { hostOnly, isLocalHost, parseHostPort } from './modules/host.js';

function safeUrl(url) {
  try { return new URL(url); } catch { return null; }
}

function safeHttpDomain(url) {
  const parsed = safeUrl(url);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return null;
  return parsed.hostname;
}

function safeHostname(url) {
  return safeUrl(url)?.hostname ?? null;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ── Events ────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Top-level startup IIFE already runs reconcile() on SW activation;
  // avoid triggering a duplicate back-to-back reconcile here.
  console.log('[SWITCH] installed/updated');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  const domain = safeHttpDomain(tab.url);
  if (!domain) {
    await setTabBadge(tabId, '');
    return;
  }
  const snap = await Config.getDomainSnapshot(domain);
  await setTabBadge(tabId, badgeTextFor(snap.managed ? snap.config : null));
  if (!snap.managed) return;
  await Cookies.capture(domain);
  bindRequestObserver(tabId, domain, snap.config.pairs);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    const domain = safeHttpDomain(tab.url);
    if (!domain) {
      await setTabBadge(tabId, '');
      return;
    }
    const snap = await Config.getDomainSnapshot(domain);
    await setTabBadge(tabId, badgeTextFor(snap.managed ? snap.config : null));
  } catch {
    // Tab closed before lookup
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  unbindRequestObserver(tabId);
  _tabBadges.delete(tabId);
});

// In-memory cache of managed domains so high-frequency events (cookies.onChanged)
// avoid hitting chrome.storage.local on unrelated tabs.
let _managedSitesCache = null; // null = not yet loaded, Set<string> once loaded

async function getManagedSet() {
  if (_managedSitesCache) return _managedSitesCache;
  _managedSitesCache = new Set(await Config.getManagedSites());
  return _managedSitesCache;
}

// Debounced cookie re-capture on browser cookie-jar churn
const _cookieCaptureQueue = new Set();
const _flushCookieCaptures = debounce(async () => {
  const domains = [..._cookieCaptureQueue];
  _cookieCaptureQueue.clear();
  for (const domain of domains) {
    await Cookies.capture(domain).catch(err => console.error('[bg] cookie capture failed:', err));
  }
}, 300);

chrome.cookies.onChanged.addListener(async ({ cookie }) => {
  const cookieDomain = cookie.domain.replace(/^\./, '').toLowerCase();
  const managed = await getManagedSet();
  if (!managed.size) return;

  let matched = false;
  for (const site of managed) {
    if (site === cookieDomain || site.endsWith(`.${cookieDomain}`)) {
      _cookieCaptureQueue.add(site);
      matched = true;
    }
  }
  if (matched) _flushCookieCaptures();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  const keys = Object.keys(changes);

  if ('managed_sites' in changes) {
    const prev = new Set(changes.managed_sites.oldValue ?? []);
    const next = changes.managed_sites.newValue ?? [];
    _managedSitesCache = new Set(next);

    // Immediately capture cookies and bind observers for newly added sites
    const added = next.filter(d => !prev.has(d));
    if (added.length) {
      Promise.all(added.map(d => Cookies.capture(d))).catch(err =>
        console.error('[bg] initial cookie capture failed:', err));
      restoreObservers().catch(() => {});
    }
  }

  const ruleAffecting = keys.some(k =>
    k === 'managed_sites' ||
    k.startsWith('config.') ||
    k.startsWith('cookies.') ||
    k.startsWith('target_cookies.')
  );
  if (ruleAffecting) scheduleReconcile();

  // Turning a site off resets the session back to the page's own cookies
  for (const key of keys) {
    if (!key.startsWith('config.')) continue;
    const { oldValue, newValue } = changes[key];
    if (oldValue?.isEnabled && !newValue?.isEnabled) {
      Cookies.clearTargetCookies(key.slice('config.'.length)).catch(err =>
        console.error('[bg] clearTargetCookies failed:', err));
    }
  }

  // Keep per-tab observer exclusion sets in sync with updated configs
  for (const key of keys) {
    if (!key.startsWith('config.')) continue;
    const domain = key.slice('config.'.length);
    const newPairs = changes[key].newValue?.pairs;
    if (!newPairs) continue;
    _tabObservers.forEach(entry => {
      if (entry.pageDomain === domain) entry.excludeTargets(newPairs);
    });
  }
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  switch (request.action) {
    case 'getStatus':
      getStatus(request.domain).then(sendResponse);
      return true;
    case 'forceCookieRead': {
      const { domain } = request;
      Cookies.capture(domain)
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    case 'getRules':
      Rules.getActive().then(sendResponse);
      return true;
  }
});

// ── Action Badge (shows active rule count on current tab) ─────

const _tabBadges = new Map(); // tabId -> last written badge text

function badgeTextFor(config) {
  if (!config?.isEnabled) return '';
  const count = (config.pairs ?? []).filter(Config.isPairActive).length;
  return count > 0 ? String(count) : '';
}

async function setTabBadge(tabId, text) {
  if (_tabBadges.get(tabId) === text) return;
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ tabId, color: '#0E1412' });
      if (chrome.action.setBadgeTextColor) {
        await chrome.action.setBadgeTextColor({ tabId, color: '#81E828' });
      }
    }
    _tabBadges.set(tabId, text);
  } catch {
    _tabBadges.delete(tabId);
  }
}

async function refreshAllBadges(byDomain) {
  try {
    const tabs = await chrome.tabs.query({});
    const updates = [];
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      const domain = safeHttpDomain(tab.url);
      const entry = domain ? byDomain.get(domain) : null;
      const text = badgeTextFor(entry?.config);
      if (_tabBadges.get(tab.id) !== text) {
        updates.push(setTabBadge(tab.id, text));
      }
    }
    if (updates.length) await Promise.all(updates);
  } catch (err) {
    console.error('[bg] refreshAllBadges failed:', err);
  }
}

// ── Reconcile: single source of truth for all runtime state ───

let _reconciling = false;
let _reconcileQueued = false;

async function reconcile() {
  if (_reconciling) { _reconcileQueued = true; return null; }
  _reconciling = true;
  try {
    const snapshot = await Config.getAllSitesSnapshot();
    _managedSitesCache = new Set(snapshot.sites);
    const enabled = [];
    for (const domain of snapshot.sites) {
      const entry = snapshot.byDomain.get(domain);
      if (!entry?.config?.isEnabled) continue;
      const cookies = Cookies.mergeCookieLists(entry.pageCookies, entry.targetCookies);
      enabled.push({ domain, config: entry.config, cookies });
    }

    await Rules.reconcile(enabled);
    syncResponseListener(enabled);
    await syncContentScripts(enabled);
    await refreshAllBadges(snapshot.byDomain);
    return snapshot;
  } catch (err) {
    console.error('[bg] reconcile failed:', err);
    return null;
  } finally {
    _reconciling = false;
    if (_reconcileQueued) { _reconcileQueued = false; reconcile(); }
  }
}

const scheduleReconcile = debounce(() => reconcile(), 150);

// ── Set-Cookie listener (covers ALL enabled targets) ──────────

let _responseListener = null;
let _responseTargetsKey = '';

function syncResponseListener(enabled) {
  const targets = [...new Set(
    enabled.flatMap(e => (e.config.pairs ?? [])
      .filter(p => Config.isPairActive(p) && p.type !== 'ws')
      .map(p => p.target))
  )];
  const key = targets.slice().sort().join(',');
  if (key === _responseTargetsKey) return;
  _responseTargetsKey = key;

  if (_responseListener) {
    chrome.webRequest.onHeadersReceived.removeListener(_responseListener);
    _responseListener = null;
  }
  if (!targets.length) return;

  // Match patterns cannot include a port; host-only matches any port.
  const urls = [...new Set(targets.map(t => {
    const host = hostOnly(t).replace(/^\[|\]$/g, '');
    return isLocalHost(t) ? `http://${host}/*` : `*://${host}/*`;
  }))];

  _responseListener = details => handleSetCookie(details).catch(err =>
    console.error('[bg] handleSetCookie failed:', err));
  chrome.webRequest.onHeadersReceived.addListener(
    _responseListener,
    { urls },
    ['responseHeaders', 'extraHeaders'],
  );
}

// ── Dynamic content-script registration ───────────────────────

let _scriptRegKey = '';
const CONTENT_SCRIPTS = [
  { id: 'switch-ws-main',   js: ['content_ws.js'],     world: 'MAIN',     needs: ['ws'] },
  { id: 'switch-http-main', js: ['content_http.js'],   world: 'MAIN',     needs: ['http'] },
  { id: 'switch-ws-bridge', js: ['content_bridge.js'], world: 'ISOLATED', needs: ['ws', 'http'] },
];

function domainsWith(enabled, type) {
  const isType = type === 'ws' ? (p => p.type === 'ws') : (p => p.type !== 'ws');
  return enabled
    .filter(e => (e.config.pairs ?? []).some(p => Config.isPairActive(p) && isType(p)))
    .map(e => e.domain);
}

async function syncContentScripts(enabled) {
  const byType = { ws: domainsWith(enabled, 'ws'), http: domainsWith(enabled, 'http') };
  const wanted = CONTENT_SCRIPTS.map(s => ({
    ...s,
    matches: [...new Set(s.needs.flatMap(t => byType[t]))].map(d => `*://${d}/*`).sort(),
  }));
  const key = wanted.map(s => `${s.id}=${s.matches.join(',')}`).join(';');
  if (key === _scriptRegKey) return;

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: CONTENT_SCRIPTS.map(s => s.id) });
    const existingIds = existing.map(s => s.id);

    const toRemove   = wanted.filter(s => !s.matches.length && existingIds.includes(s.id)).map(s => s.id);
    const active     = wanted
      .filter(s => s.matches.length)
      .map(({ id, js, world, matches }) => ({ id, js, world, matches, runAt: 'document_start', persistAcrossSessions: true }));
    const toRegister = active.filter(s => !existingIds.includes(s.id));
    const toUpdate   = active.filter(s =>  existingIds.includes(s.id));

    if (toRemove.length)   await chrome.scripting.unregisterContentScripts({ ids: toRemove });
    if (toRegister.length) await chrome.scripting.registerContentScripts(toRegister);
    if (toUpdate.length)   await chrome.scripting.updateContentScripts(toUpdate);
    _scriptRegKey = key;
  } catch (err) {
    console.error('[bg] syncContentScripts failed:', err);
    _scriptRegKey = '';
  }
}

// ── Request observer (batched auto-discovery) ─────────────────

const _tabObservers = new Map();
const _observedQueue = new Map(); // pageDomain -> Map("type|host", { domain, type })

const _flushObserved = debounce(async () => {
  const entries = [..._observedQueue.entries()];
  _observedQueue.clear();
  for (const [pageDomain, map] of entries) {
    await Config.addObservedApis(pageDomain, [...map.values()]).catch(() => {});
  }
}, 300);

function queueObserved(pageDomain, apiDomain, type) {
  let bucket = _observedQueue.get(pageDomain);
  if (!bucket) {
    bucket = new Map();
    _observedQueue.set(pageDomain, bucket);
  }
  bucket.set(`${type}|${apiDomain}`, { domain: apiDomain, type });
  _flushObserved();
}

const IGNORE_EXACT = new Set([
  'fonts.googleapis.com', 'fonts.gstatic.com',
  'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com',
  'www.google-analytics.com', 'analytics.google.com',
  'www.googletagmanager.com', 'hotjar.com', 'static.hotjar.com',
]);

const IGNORE_SUFFIXES = [
  '.google.com',
  '.sentry.io',
  '.hotjar.com',
];

function isIgnored(hostname) {
  return IGNORE_EXACT.has(hostname) || IGNORE_SUFFIXES.some(s => hostname.endsWith(s));
}

function buildExcludeTargets(pairs) {
  return new Set(
    (pairs ?? [])
      .filter(p => p.target)
      .map(p => `${p.type}|${hostOnly(p.target).toLowerCase()}`)
  );
}

function bindRequestObserver(tabId, pageDomain, initialPairs = null) {
  unbindRequestObserver(tabId);

  let excludeTargets = initialPairs ? buildExcludeTargets(initialPairs) : new Set();
  if (!initialPairs) {
    Config.getConfig(pageDomain)
      .then(c => { excludeTargets = buildExcludeTargets(c.pairs); })
      .catch(() => {});
  }

  const listener = (details) => {
    const hostname = safeHostname(details.url);
    if (!hostname || hostname === pageDomain) return;
    if (isIgnored(hostname)) return;
    const type = /^wss?:\/\//i.test(details.url) ? 'ws' : 'http';
    if (excludeTargets.has(`${type}|${hostname.toLowerCase()}`)) return;
    queueObserved(pageDomain, hostname, type);
  };

  chrome.webRequest.onBeforeRequest.addListener(
    listener,
    { urls: ['<all_urls>'], tabId, types: ['xmlhttprequest', 'websocket'] },
  );
  _tabObservers.set(tabId, {
    listener,
    pageDomain,
    excludeTargets: (pairs) => { excludeTargets = buildExcludeTargets(pairs); },
  });
}

function unbindRequestObserver(tabId) {
  const entry = _tabObservers.get(tabId);
  if (!entry) return;
  chrome.webRequest.onBeforeRequest.removeListener(entry.listener);
  _tabObservers.delete(tabId);
}

async function restoreObservers(snapshot = null) {
  try {
    const data = snapshot ?? await Config.getAllSitesSnapshot();
    if (!data.sites.length) return;
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      const domain = safeHttpDomain(tab.url);
      const entry = domain ? data.byDomain.get(domain) : null;
      if (entry) {
        bindRequestObserver(tab.id, domain, entry.config.pairs);
      }
    }
  } catch (err) {
    console.error('[bg] restoreObservers failed:', err);
  }
}

// ── Set-Cookie handling (tab-first + port-exact matching) ─────

function targetMatchesUrl(target, parsedUrl) {
  const { host, port } = parseHostPort(target);
  if (host.toLowerCase() !== parsedUrl.hostname.toLowerCase()) return false;
  if (port) return parsedUrl.port === port;
  return true;
}

async function resolveOwnerDomainForResponse(details, parsedUrl) {
  // Prefer the tab that initiated the request so two frontends targeting
  // different local ports (e.g. localhost:3000 vs localhost:8080) never collide.
  if (typeof details.tabId === 'number' && details.tabId >= 0) {
    let tabDomain = _tabObservers.get(details.tabId)?.pageDomain ?? null;
    if (!tabDomain) {
      try {
        const tab = await chrome.tabs.get(details.tabId);
        tabDomain = safeHttpDomain(tab.url);
      } catch { /* tab closed */ }
    }
    if (tabDomain && await Config.isManaged(tabDomain)) {
      const cfg = await Config.getConfig(tabDomain);
      if (cfg.isEnabled && (cfg.pairs ?? []).some(p => Config.isPairActive(p) && targetMatchesUrl(p.target, parsedUrl))) {
        return tabDomain;
      }
    }
  }

  // Fallback for requests without a tabId (e.g. worker contexts)
  const sites = await Config.getManagedSites();
  for (const domain of sites) {
    const config = await Config.getConfig(domain);
    if (!config.isEnabled) continue;
    if ((config.pairs ?? []).some(p => Config.isPairActive(p) && targetMatchesUrl(p.target, parsedUrl))) {
      return domain;
    }
  }
  return null;
}

async function handleSetCookie(details) {
  const setCookieHeaders = (details.responseHeaders ?? [])
    .filter(h => h.name.toLowerCase() === 'set-cookie');
  if (setCookieHeaders.length === 0) return;

  const parsedUrl = safeUrl(details.url);
  if (!parsedUrl) return;

  const ownerDomain = await resolveOwnerDomainForResponse(details, parsedUrl);
  if (ownerDomain) {
    await Cookies.mergeFromSetCookie(setCookieHeaders, ownerDomain);
  }
}

// ── Status (popup/devtools) ───────────────────────────────────

async function getStatus(domain) {
  const [config, cookieBreakdown, rules] = await Promise.all([
    Config.getConfig(domain),
    Cookies.getStoredBreakdown(domain),
    Rules.getActive(),
  ]);
  return {
    config,
    cookieCount: cookieBreakdown.merged.length,
    pageCookieCount: cookieBreakdown.page.length,
    targetCookieCount: cookieBreakdown.target.length,
    rules,
  };
}

// ── Startup: rebuild everything from persistent state ─────────
// Invoked at the bottom of the module so lexical bindings are initialized.
(async () => {
  const snapshot = await reconcile();
  await restoreObservers(snapshot);
})().catch(err => console.error('[bg] startup failed:', err));
