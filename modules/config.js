// Config & site management — chrome.storage.local
import { SWITCHIT_CONSTANTS } from '../constants.js';

const { STORAGE_KEYS, DEFAULT_CONFIG } = SWITCHIT_CONSTANTS;

// ── Site list ─────────────────────────────────────────────────

export async function getManagedSites() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.MANAGED_SITES);
  return result[STORAGE_KEYS.MANAGED_SITES] ?? [];
}

export async function addSite(domain) {
  const sites = await getManagedSites();
  if (sites.includes(domain)) return;
  const configKey = STORAGE_KEYS.CONFIG_PREFIX + domain;
  const existing  = await chrome.storage.local.get(configKey);
  await chrome.storage.local.set({
    [STORAGE_KEYS.MANAGED_SITES]: [...sites, domain],
    ...(existing[configKey] ? {} : { [configKey]: structuredClone(DEFAULT_CONFIG) }),
  });
}

/**
 * Infer the API domain from a frontend domain.
 * test.chaintable.com → test-api.chaintable.com
 * app.myco.io        → app-api.myco.io
 */
export function inferApiDomain(domain) {
  const parts = domain.split('.');
  if (parts.length < 2) return '';
  parts[0] = `${parts[0]}-api`;
  return parts.join('.');
}

export async function removeSite(domain) {
  const sites = await getManagedSites();
  await chrome.storage.local.set({
    [STORAGE_KEYS.MANAGED_SITES]: sites.filter(s => s !== domain),
  });
  await chrome.storage.local.remove([
    STORAGE_KEYS.CONFIG_PREFIX   + domain,
    STORAGE_KEYS.COOKIES_PREFIX  + domain,
    STORAGE_KEYS.OBSERVED_PREFIX + domain,
  ]);
}

export async function isManaged(domain) {
  const sites = await getManagedSites();
  return sites.includes(domain);
}

// ── Per-domain config ─────────────────────────────────────────

export async function getConfig(domain) {
  const key = STORAGE_KEYS.CONFIG_PREFIX + domain;
  const result = await chrome.storage.local.get(key);
  const stored = result[key];
  if (!stored) return structuredClone(DEFAULT_CONFIG);

  // Migrate v1 schema (originalApi/targetApi)
  if ('originalApi' in stored || 'targetApi' in stored) {
    const migrated = {
      isEnabled: stored.isEnabled ?? false,
      pairs: [
        { type: 'http', original: stored.originalApi ?? '', target: stored.targetApi ?? '' },
        { type: 'ws',   original: '', target: '' },
      ],
    };
    await chrome.storage.local.set({ [key]: migrated });
    return migrated;
  }

  // Migrate v2 schema (httpOriginal/wsOriginal flat fields)
  if ('httpOriginal' in stored || 'wsOriginal' in stored) {
    const migrated = {
      isEnabled: stored.isEnabled ?? false,
      pairs: [
        { type: 'http', original: stored.httpOriginal ?? '', target: stored.httpTarget ?? '' },
        { type: 'ws',   original: stored.wsOriginal   ?? '', target: stored.wsTarget   ?? '' },
      ],
    };
    await chrome.storage.local.set({ [key]: migrated });
    return migrated;
  }

  // Ensure pairs array exists
  if (!Array.isArray(stored.pairs)) {
    stored.pairs = structuredClone(DEFAULT_CONFIG.pairs);
  }

  return stored;
}

/** Partial update — only supplied keys are changed */
export async function setConfig(domain, patch) {
  const key = STORAGE_KEYS.CONFIG_PREFIX + domain;
  const current = await getConfig(domain);
  await chrome.storage.local.set({ [key]: { ...current, ...patch } });
}

// ── Observed API domains ───────────────────────────────────────

const OBSERVED_MAX = 30;

export async function getObservedApis(domain) {
  const key = STORAGE_KEYS.OBSERVED_PREFIX + domain;
  const result = await chrome.storage.local.get(key);
  return result[key] ?? [];
}

export async function addObservedApi(pageDomain, apiDomain, type = 'http') {
  const key = STORAGE_KEYS.OBSERVED_PREFIX + pageDomain;
  const list = await getObservedApis(pageDomain);
  const updated = [
    { domain: apiDomain, type },
    ...list.filter(item => !(item.domain === apiDomain && item.type === type)),
  ].slice(0, OBSERVED_MAX);
  await chrome.storage.local.set({ [key]: updated });
}

export async function removeObservedApi(pageDomain, apiDomain) {
  const key = STORAGE_KEYS.OBSERVED_PREFIX + pageDomain;
  const list = await getObservedApis(pageDomain);
  await chrome.storage.local.set({ [key]: list.filter(item => item.domain !== apiDomain) });
}
