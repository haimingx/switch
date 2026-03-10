// SWITCH Service Worker — ES Module
import * as Config  from './modules/config.js';
import * as Cookies from './modules/cookies.js';
import * as Rules   from './modules/rules.js';
import { SWITCHIT_CONSTANTS } from './constants.js';

const { LOCALHOST_RE } = SWITCHIT_CONSTANTS;

function isLocalTarget(host) {
  return LOCALHOST_RE.test(host.split(':')[0]);
}

// Top-level: restore rules on every SW wake-up
restoreAllRules().catch(err => console.error('[bg] restoreAllRules failed:', err));

// ── Events ────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await Rules.clear(); // flush any stale/invalid rules persisted by previous version
  console.log('[SWITCH] installed/updated');
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  const domain = safeHostname(tab.url);
  if (!domain || !(await Config.isManaged(domain))) return;
  await Cookies.capture(domain);
  await refreshCookieRule(domain);
  bindRequestObserver(tabId, domain);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  unbindRequestObserver(tabId);
});

chrome.cookies.onChanged.addListener(async ({ cookie }) => {
  const domain = cookie.domain.replace(/^\./, '');
  if (!(await Config.isManaged(domain))) return;
  await Cookies.capture(domain);
  await refreshCookieRule(domain);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  const configKey = Object.keys(changes).find(k => k.startsWith('config.'));
  if (!configKey) return;
  const domain = configKey.slice('config.'.length);
  await applyRulesForDomain(domain);

  // Keep observer exclusion sets in sync with updated config
  const newPairs = changes[configKey].newValue?.pairs;
  if (newPairs) {
    _tabObservers.forEach(entry => {
      if (entry.pageDomain === domain) entry.excludeTargets?.(newPairs);
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
        .then(() => refreshCookieRule(domain))
        .then(() => sendResponse({ success: true }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
    case 'getRules':
      Rules.getActive().then(sendResponse);
      return true;
  }
});

// ── Set-Cookie listener ───────────────────────────────────────

let _responseListener = null;
let _listeningTarget  = null;

function bindResponseListener(targetApi) {
  if (_listeningTarget === targetApi) return;
  if (_responseListener) {
    chrome.webRequest.onHeadersReceived.removeListener(_responseListener);
  }
  _responseListener = details => handleSetCookie(details).catch(console.error);
  _listeningTarget  = targetApi;
  // Chrome match patterns don't allow '*' scheme with a port number,
  // so use 'http://' explicitly for localhost/IP targets.
  chrome.webRequest.onHeadersReceived.addListener(
    _responseListener,
    { urls: [isLocalTarget(targetApi) ? `http://${targetApi}/*` : `*://${targetApi}/*`] },
    ['responseHeaders', 'extraHeaders'],
  );
}

function unbindResponseListener() {
  if (!_responseListener) return;
  chrome.webRequest.onHeadersReceived.removeListener(_responseListener);
  _responseListener = null;
  _listeningTarget  = null;
}

// ── Request observer (page-caught) ────────────────────────────

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
  _tabObservers.set(tabId, { listener, pageDomain, excludeTargets: (pairs) => { excludeTargets = buildExcludeTargets(pairs); } });
}

function unbindRequestObserver(tabId) {
  const entry = _tabObservers.get(tabId);
  if (!entry) return;
  chrome.webRequest.onBeforeRequest.removeListener(entry.listener);
  _tabObservers.delete(tabId);
}

// ── Core helpers ──────────────────────────────────────────────

async function restoreAllRules() {
  const sites = await Config.getManagedSites();
  const enabled = [];
  for (const domain of sites) {
    const config = await Config.getConfig(domain);
    if (config.isEnabled) {
      await applyRulesForDomain(domain);
      enabled.push(domain);
    }
  }
  if (enabled.length) console.log(`[bg] restored rules for: ${enabled.join(', ')}`);
}

async function applyRulesForDomain(domain) {
  const config = await Config.getConfig(domain);
  const activePairs = (config.pairs ?? []).filter(p => p.original && p.target);

  if (config.isEnabled && activePairs.length > 0) {
    const cookies = await Cookies.getStored(domain);
    await Rules.apply(config.pairs, cookies);
    const primaryTarget = (activePairs.find(p => p.type !== 'ws') ?? activePairs[0]).target;
    bindResponseListener(primaryTarget);
  } else {
    await Rules.clear();
    unbindResponseListener();
  }
}

async function refreshCookieRule(domain) {
  const config = await Config.getConfig(domain);
  if (!config.isEnabled) return;
  const primaryTarget = (config.pairs ?? []).find(p => p.target && p.type !== 'ws')?.target;
  if (!primaryTarget) return;
  const cookies = await Cookies.getStored(domain);
  await Rules.updateCookieOnly(primaryTarget, cookies);
}

async function handleSetCookie(details) {
  const setCookieHeaders = (details.responseHeaders ?? [])
    .filter(h => h.name.toLowerCase() === 'set-cookie');
  if (setCookieHeaders.length === 0) return;

  const targetHostname = safeHostname(details.url);
  if (!targetHostname) return;

  const sites = await Config.getManagedSites();
  for (const domain of sites) {
    const config = await Config.getConfig(domain);
    const match = (config.pairs ?? []).find(p => p.target === targetHostname);
    if (match && config.isEnabled) {
      const updated = await Cookies.mergeFromSetCookie(setCookieHeaders, domain);
      await Rules.updateCookieOnly(targetHostname, updated);
      break;
    }
  }
}

async function getStatus(domain) {
  const [config, cookies, rules] = await Promise.all([
    Config.getConfig(domain),
    Cookies.getStored(domain),
    Rules.getActive(),
  ]);
  return { config, cookieCount: cookies.length, rules };
}

function safeHostname(url) {
  try { return new URL(url).hostname; } catch { return null; }
}
