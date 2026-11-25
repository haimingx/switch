// Config & site management — chrome.storage.local
import { SWITCH_CONSTANTS } from '../constants.js';
import { inferApiDomain, validateDomain } from './host.js';

export { inferApiDomain };

const { STORAGE_KEYS, DEFAULT_CONFIG } = SWITCH_CONSTANTS;
const OBSERVED_MAX = 30;

export function createPairId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizePair(pair, index = null) {
  const fallbackId = typeof index === 'number' ? `legacy_${index}` : createPairId();
  return {
    id:       typeof pair?.id === 'string' && pair.id ? pair.id : fallbackId,
    type:     pair?.type === 'ws' ? 'ws' : 'http',
    original: typeof pair?.original === 'string' ? pair.original.trim() : '',
    target:   typeof pair?.target === 'string' ? pair.target.trim() : '',
    enabled:  pair?.enabled !== false,
  };
}

export function isPairActive(pair) {
  return pair?.enabled !== false && Boolean(pair?.original) && Boolean(pair?.target);
}

// ── Site list ─────────────────────────────────────────────────

export async function getManagedSites() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.MANAGED_SITES);
  return result[STORAGE_KEYS.MANAGED_SITES] ?? [];
}

export async function addSite(domain) {
  const normalized = String(domain ?? '').trim().toLowerCase();
  if (!normalized) return;
  const sites = await getManagedSites();
  if (sites.includes(normalized)) return;
  const configKey = STORAGE_KEYS.CONFIG_PREFIX + normalized;
  const existing  = await chrome.storage.local.get(configKey);
  await chrome.storage.local.set({
    [STORAGE_KEYS.MANAGED_SITES]: [...sites, normalized],
    ...(existing[configKey] ? {} : { [configKey]: structuredClone(DEFAULT_CONFIG) }),
  });
}

export async function removeSite(domain) {
  const sites = await getManagedSites();
  await chrome.storage.local.set({
    [STORAGE_KEYS.MANAGED_SITES]: sites.filter(s => s !== domain),
  });
  await chrome.storage.local.remove([
    STORAGE_KEYS.CONFIG_PREFIX         + domain,
    STORAGE_KEYS.COOKIES_PREFIX        + domain,
    STORAGE_KEYS.TARGET_COOKIES_PREFIX + domain,
    STORAGE_KEYS.OBSERVED_PREFIX       + domain,
  ]);
}

export async function isManaged(domain) {
  const sites = await getManagedSites();
  return sites.includes(domain);
}

// ── Per-domain config ─────────────────────────────────────────

// Pure normalization of a raw stored config object (no storage writes on read)
export function normalizeConfig(stored) {
  if (!stored) return structuredClone(DEFAULT_CONFIG);

  let pairs = stored.pairs;
  if ('originalApi' in stored || 'targetApi' in stored) {
    pairs = [
      { type: 'http', original: stored.originalApi ?? '', target: stored.targetApi ?? '' },
    ];
  } else if ('httpOriginal' in stored || 'wsOriginal' in stored) {
    pairs = [
      { type: 'http', original: stored.httpOriginal ?? '', target: stored.httpTarget ?? '' },
      { type: 'ws',   original: stored.wsOriginal   ?? '', target: stored.wsTarget   ?? '' },
    ].filter(p => p.original || p.target);
  } else if (!Array.isArray(pairs)) {
    pairs = [];
  }

  return {
    isEnabled: Boolean(stored.isEnabled),
    pairs: pairs.map((p, idx) => normalizePair(p, idx)),
  };
}

export async function getConfig(domain) {
  const key = STORAGE_KEYS.CONFIG_PREFIX + domain;
  const result = await chrome.storage.local.get(key);
  return normalizeConfig(result[key]);
}

// Single-IPC snapshot for popup render (replaces 4-5 separate storage reads)
export async function getDomainSnapshot(domain) {
  const cfgKey = STORAGE_KEYS.CONFIG_PREFIX + domain;
  const pageCk = STORAGE_KEYS.COOKIES_PREFIX + domain;
  const tgtCk  = STORAGE_KEYS.TARGET_COOKIES_PREFIX + domain;
  const obsKey = STORAGE_KEYS.OBSERVED_PREFIX + domain;

  const res = await chrome.storage.local.get([
    STORAGE_KEYS.MANAGED_SITES,
    cfgKey,
    pageCk,
    tgtCk,
    obsKey,
  ]);

  const sites = res[STORAGE_KEYS.MANAGED_SITES] ?? [];
  return {
    managed:       sites.includes(domain),
    config:        normalizeConfig(res[cfgKey]),
    pageCookies:   res[pageCk] ?? [],
    targetCookies: res[tgtCk]  ?? [],
    observed:      res[obsKey] ?? [],
  };
}

// Single-IPC snapshot of all managed sites for service-worker reconcile
export async function getAllSitesSnapshot() {
  const sites = await getManagedSites();
  if (!sites.length) return { sites: [], byDomain: new Map() };

  const keys = [];
  for (const d of sites) {
    keys.push(
      STORAGE_KEYS.CONFIG_PREFIX + d,
      STORAGE_KEYS.COOKIES_PREFIX + d,
      STORAGE_KEYS.TARGET_COOKIES_PREFIX + d,
    );
  }

  const res = await chrome.storage.local.get(keys);
  const byDomain = new Map();
  for (const d of sites) {
    byDomain.set(d, {
      config:        normalizeConfig(res[STORAGE_KEYS.CONFIG_PREFIX + d]),
      pageCookies:   res[STORAGE_KEYS.COOKIES_PREFIX + d] ?? [],
      targetCookies: res[STORAGE_KEYS.TARGET_COOKIES_PREFIX + d] ?? [],
    });
  }
  return { sites, byDomain };
}

export async function setConfig(domain, patch) {
  const key = STORAGE_KEYS.CONFIG_PREFIX + domain;
  const current = await getConfig(domain);
  const next = { ...current, ...patch };
  if (Array.isArray(next.pairs)) {
    next.pairs = next.pairs.map(p => normalizePair(p));
  }
  await chrome.storage.local.set({ [key]: next });
  return next;
}

// ── Observed API domains ──────────────────────────────────────

export async function getObservedApis(domain) {
  const key = STORAGE_KEYS.OBSERVED_PREFIX + domain;
  const result = await chrome.storage.local.get(key);
  return result[key] ?? [];
}

export async function addObservedApis(pageDomain, items) {
  if (!items.length) return;
  const key = STORAGE_KEYS.OBSERVED_PREFIX + pageDomain;
  const existing = await getObservedApis(pageDomain);
  const seen = new Set();
  const merged = [];

  for (const item of [...items, ...existing]) {
    const k = `${item.type}|${item.domain}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push({ domain: item.domain, type: item.type === 'ws' ? 'ws' : 'http' });
    if (merged.length >= OBSERVED_MAX) break;
  }

  await chrome.storage.local.set({ [key]: merged });
}

export async function removeObservedApi(pageDomain, apiDomain, type) {
  const key = STORAGE_KEYS.OBSERVED_PREFIX + pageDomain;
  const list = await getObservedApis(pageDomain);
  const next = list.filter(item =>
    type ? !(item.domain === apiDomain && item.type === type) : item.domain !== apiDomain
  );
  await chrome.storage.local.set({ [key]: next });
}

// ── Backup / Restore validation ───────────────────────────────

// Export ONLY site list and routing rules — never session cookies.
export function buildExportPayload(allStorage) {
  const sites = Array.isArray(allStorage?.[STORAGE_KEYS.MANAGED_SITES])
    ? allStorage[STORAGE_KEYS.MANAGED_SITES]
    : [];
  const out = { [STORAGE_KEYS.MANAGED_SITES]: [...sites] };
  for (const domain of sites) {
    const cfgKey = STORAGE_KEYS.CONFIG_PREFIX + domain;
    if (allStorage && cfgKey in allStorage) {
      out[cfgKey] = normalizeConfig(allStorage[cfgKey]);
    }
  }
  return out;
}

export function parseImportPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Backup file must be a JSON object.');
  }
  const sites = Array.isArray(raw[STORAGE_KEYS.MANAGED_SITES])
    ? [...new Set(raw[STORAGE_KEYS.MANAGED_SITES].filter(s => typeof s === 'string' && validateDomain(s) && s.trim()))]
    : [];

  if (!sites.length) {
    throw new Error('Backup file does not contain any valid managed_sites.');
  }

  const out = { [STORAGE_KEYS.MANAGED_SITES]: sites };
  for (const domain of sites) {
    const cfgKey = STORAGE_KEYS.CONFIG_PREFIX + domain;
    const cfg = raw[cfgKey];
    out[cfgKey] = {
      isEnabled: Boolean(cfg?.isEnabled),
      pairs: Array.isArray(cfg?.pairs) ? cfg.pairs.map(p => normalizePair(p)) : [],
    };
  }
  return out;
}
