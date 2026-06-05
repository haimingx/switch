// SWITCH Service Worker — ES Module
import * as Config  from './modules/config.js';
import * as Cookies from './modules/cookies.js';
import * as Rules   from './modules/rules.js';
import { SWITCHIT_CONSTANTS } from './constants.js';

const { LOCALHOST_RE } = SWITCHIT_CONSTANTS;

function isLocalTarget(host) {
  return LOCALHOST_RE.test(host.split(':')[0]);
}

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

// Strip an optional :port so we can compare against URL().hostname.
function hostOnly(hostMaybePort) {
  return hostMaybePort.split(':')[0];
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// ── Events ────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  // reconcile() already replaces the full dynamic ruleset, flushing anything
  // stale persisted by a previous version.
  await reconcile().catch(err => console.error('[bg] onInstalled reconcile failed:', err));
  console.log('[SWITCH] installed/updated');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  const domain = safeHostname(tab.url);
  if (!domain || !(await Config.isManaged(domain))) return;
  // Capturing cookies writes cookies.<domain>, which triggers storage.onChanged
  // → scheduleReconcile, so the cookie-inject rule stays current.
  await Cookies.capture(domain);
  bindRequestObserver(tabId, domain);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  unbindRequestObserver(tabId);
});

// Re-capture cookies when the browser's cookie jar changes for a managed
// domain. Debounced because cookie churn can be very chatty.
const _cookieCaptureQueue = new Set();
const _flushCookieCaptures = debounce(async () => {
  const domains = [..._cookieCaptureQueue];
  _cookieCaptureQueue.clear();
  for (const domain of domains) {
    await Cookies.capture(domain).catch(err => console.error('[bg] cookie capture failed:', err));
  }
}, 300);

chrome.cookies.onChanged.addListener(async ({ cookie }) => {
  const domain = cookie.domain.replace(/^\./, '');
  if (!(await Config.isManaged(domain))) return;
  _cookieCaptureQueue.add(domain);
  _flushCookieCaptures();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  const keys = Object.keys(changes);
  const ruleAffecting = keys.some(k =>
    k === 'managed_sites' || k.startsWith('config.') || k.startsWith('cookies.'));
  if (ruleAffecting) scheduleReconcile();

  // Keep per-tab observer exclusion sets in sync with updated config(s).
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
      // capture() persists cookies → storage.onChanged → reconcile rebuilds rules.
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

// ── Reconcile: single source of truth for all runtime state ───
// Any change to managed sites / config / cookies funnels here. We rebuild the
// whole DNR ruleset, the Set-Cookie listener target set, and the dynamic WS
// content-script registrations from the full set of enabled sites.

let _reconciling = false;
let _reconcileQueued = false;

async function reconcile() {
  if (_reconciling) { _reconcileQueued = true; return; }
  _reconciling = true;
  try {
    const domains = await Config.getManagedSites();
    const enabled = [];
    for (const domain of domains) {
      const config = await Config.getConfig(domain);
      if (!config.isEnabled) continue;
      const cookies = await Cookies.getStored(domain);
      enabled.push({ domain, config, cookies });
    }

    await Rules.reconcile(enabled);
    syncResponseListener(enabled);
    await syncWsContentScripts(enabled);
  } catch (err) {
    console.error('[bg] reconcile failed:', err);
  } finally {
    _reconciling = false;
    if (_reconcileQueued) { _reconcileQueued = false; reconcile(); }
  }
}

const scheduleReconcile = debounce(() => reconcile(), 150);

// ── Set-Cookie listener (covers ALL enabled targets) ──────────
// A single onHeadersReceived listener registered for the union of every enabled
// target. handleSetCookie() figures out which managed domain each response
// belongs to, so one listener serves any number of targets.

let _responseListener = null;
let _responseTargetsKey = '';

function syncResponseListener(enabled) {
  const targets = [...new Set(
    enabled.flatMap(e => (e.config.pairs ?? [])
      .filter(p => p.target && p.type !== 'ws')
      .map(p => p.target))
  )];
  const key = targets.slice().sort().join(',');
  if (key === _responseTargetsKey) return; // nothing changed
  _responseTargetsKey = key;

  if (_responseListener) {
    chrome.webRequest.onHeadersReceived.removeListener(_responseListener);
    _responseListener = null;
  }
  if (!targets.length) return;

  // Match patterns can't contain a port; use host-only (matches any port).
  const urls = targets.map(t => {
    const host = hostOnly(t);
    return isLocalTarget(t) ? `http://${host}/*` : `*://${host}/*`;
  });

  _responseListener = details => handleSetCookie(details).catch(err =>
    console.error('[bg] handleSetCookie failed:', err));
  chrome.webRequest.onHeadersReceived.addListener(
    _responseListener,
    { urls },
    ['responseHeaders', 'extraHeaders'],
  );
}

// ── Dynamic WS content-script registration ────────────────────
// content_ws.js (MAIN world) + content_bridge.js are injected ONLY on domains
// that actually have an enabled WS pair. Every other page is untouched — its
// window.WebSocket is never hooked (footprint + compatibility, see plan #3).

let _wsRegKey = '';
const WS_SCRIPT_IDS = ['switch-ws-main', 'switch-ws-bridge'];

async function syncWsContentScripts(enabled) {
  const wsDomains = [...new Set(
    enabled
      .filter(e => (e.config.pairs ?? []).some(p => p.type === 'ws' && p.original && p.target))
      .map(e => e.domain)
  )];
  const matches = wsDomains.map(d => `*://${d}/*`).sort();
  const key = matches.join(',');
  if (key === _wsRegKey) return;

  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: WS_SCRIPT_IDS });
    const existingIds = existing.map(s => s.id);

    if (!matches.length) {
      if (existingIds.length) await chrome.scripting.unregisterContentScripts({ ids: existingIds });
      _wsRegKey = key;
      return;
    }

    const scripts = [
      { id: 'switch-ws-main',   matches, js: ['content_ws.js'],     runAt: 'document_start', world: 'MAIN',     persistAcrossSessions: true },
      { id: 'switch-ws-bridge', matches, js: ['content_bridge.js'], runAt: 'document_start', world: 'ISOLATED', persistAcrossSessions: true },
    ];
    const toRegister = scripts.filter(s => !existingIds.includes(s.id));
    const toUpdate   = scripts.filter(s =>  existingIds.includes(s.id));
    if (toRegister.length) await chrome.scripting.registerContentScripts(toRegister);
    if (toUpdate.length)   await chrome.scripting.updateContentScripts(toUpdate);
    _wsRegKey = key;
  } catch (err) {
    console.error('[bg] syncWsContentScripts failed:', err);
    _wsRegKey = ''; // force retry on next reconcile
  }
}

// ── Request observer (page-caught API auto-discovery) ─────────

const _tabObservers = new Map();

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
    (pairs ?? []).filter(p => p.target).map(p => {
      const hostname = safeHostname(`http://${p.target}`) ?? p.target;
      return `${p.type}|${hostname}`;
    })
  );
}

function bindRequestObserver(tabId, pageDomain) {
  unbindRequestObserver(tabId);

  // Mutable exclusion set — populated now, refreshed on config changes
  let excludeTargets = new Set();
  Config.getConfig(pageDomain)
    .then(c => { excludeTargets = buildExcludeTargets(c.pairs); })
    .catch(() => {});

  const listener = (details) => {
    const hostname = safeHostname(details.url);
    if (!hostname || hostname === pageDomain) return;
    if (isIgnored(hostname)) return;
    const type = /^wss?:\/\//i.test(details.url) ? 'ws' : 'http';
    if (excludeTargets.has(`${type}|${hostname}`)) return;
    Config.addObservedApi(pageDomain, hostname, type).catch(() => {});
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

// Re-derive observers for all currently-open managed tabs. Called on SW
// startup so API auto-discovery survives a service-worker restart without the
// user having to reload the page (plan #2).
async function restoreObservers() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id || !tab.url) continue;
      const domain = safeHostname(tab.url);
      if (domain && await Config.isManaged(domain)) {
        bindRequestObserver(tab.id, domain);
      }
    }
  } catch (err) {
    console.error('[bg] restoreObservers failed:', err);
  }
}

// ── Set-Cookie handling ───────────────────────────────────────

async function handleSetCookie(details) {
  const setCookieHeaders = (details.responseHeaders ?? [])
    .filter(h => h.name.toLowerCase() === 'set-cookie');
  if (setCookieHeaders.length === 0) return;

  const targetHostname = safeHostname(details.url);
  if (!targetHostname) return;

  const sites = await Config.getManagedSites();
  for (const domain of sites) {
    const config = await Config.getConfig(domain);
    if (!config.isEnabled) continue;
    // Compare host-only so targets that include a :port still match.
    const match = (config.pairs ?? []).find(p => p.target && hostOnly(p.target) === targetHostname);
    if (match) {
      // Persisting merged cookies triggers storage.onChanged → reconcile.
      await Cookies.mergeFromSetCookie(setCookieHeaders, domain);
      break;
    }
  }
}

// ── Status (popup/devtools) ───────────────────────────────────

async function getStatus(domain) {
  const [config, cookies, rules] = await Promise.all([
    Config.getConfig(domain),
    Cookies.getStored(domain),
    Rules.getActive(),
  ]);
  return { config, cookieCount: cookies.length, rules };
}

// ── Startup: rebuild everything from persistent state ─────────
// MV3 service workers are killed when idle; on every wake-up we re-derive all
// runtime state (DNR rules, listeners, per-tab observers) from chrome.storage
// and chrome.tabs rather than relying on anything held in memory.
//
// Invoked at the BOTTOM of the module so the `let`/`const` state it reads
// (e.g. _reconciling) is already initialized — function declarations hoist,
// but lexical bindings stay in the temporal dead zone until this point.
(async () => {
  await reconcile();
  await restoreObservers();
})().catch(err => console.error('[bg] startup failed:', err));
