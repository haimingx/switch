// Cookie capture, filtering, storage, and Set-Cookie handling
import { SWITCH_CONSTANTS } from '../constants.js';

const { STORAGE_KEYS, TRACKING_COOKIE_PREFIXES } = SWITCH_CONSTANTS;

// ── Pure helpers (exported for unit tests) ────────────────────

export function isTrackingCookie(name) {
  const lower = String(name ?? '').toLowerCase();
  return TRACKING_COOKIE_PREFIXES.some(p => lower.startsWith(p));
}

// Deduplicate by cookie name — first occurrence wins so host-specific cookies
// take precedence over broader parent-domain cookies of the same name.
export function dedupeAndFilter(cookies) {
  const seen = new Set();
  const out = [];
  for (const c of cookies) {
    if (!c?.name || seen.has(c.name) || isTrackingCookie(c.name)) continue;
    seen.add(c.name);
    out.push({ name: c.name, value: c.value });
  }
  return out;
}

export function parseCookieHeader(str) {
  const semi = String(str ?? '').indexOf(';');
  const pair = semi > -1 ? str.slice(0, semi) : String(str ?? '');
  const eq = pair.indexOf('=');
  if (eq < 1) return null;
  return {
    name:  pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
  };
}

export function mergeCookieLists(pageCookies, targetCookies) {
  const map = new Map((pageCookies ?? []).map(c => [c.name, c.value]));
  for (const c of targetCookies ?? []) map.set(c.name, c.value);
  return Array.from(map.entries(), ([name, value]) => ({ name, value }));
}

// ── Chrome storage / cookies API ──────────────────────────────

export async function capture(domain) {
  try {
    // Ordered most-specific first so host cookies win over parent-domain cookies
    const queries = [
      chrome.cookies.getAll({ url: `https://${domain}` }),
      chrome.cookies.getAll({ url: `http://${domain}` }),
      chrome.cookies.getAll({ domain }),
      chrome.cookies.getAll({ domain: `.${domain}` }),
    ];

    const parts = domain.split('.');
    if (parts.length > 2) {
      const parent = parts.slice(1).join('.');
      queries.push(
        chrome.cookies.getAll({ domain: `.${parent}` }),
        chrome.cookies.getAll({ url: `https://${parent}` }),
      );
    }

    const all = (await Promise.all(queries)).flat();
    const filtered = dedupeAndFilter(all);

    await chrome.storage.local.set({
      [STORAGE_KEYS.COOKIES_PREFIX + domain]: filtered,
    });
    return filtered;
  } catch (err) {
    console.error('[cookies] capture error:', err);
    return [];
  }
}

export async function getStored(domain) {
  const pageKey   = STORAGE_KEYS.COOKIES_PREFIX + domain;
  const targetKey = STORAGE_KEYS.TARGET_COOKIES_PREFIX + domain;
  const result = await chrome.storage.local.get([pageKey, targetKey]);
  return mergeCookieLists(result[pageKey], result[targetKey]);
}

export async function getStoredBreakdown(domain) {
  const pageKey   = STORAGE_KEYS.COOKIES_PREFIX + domain;
  const targetKey = STORAGE_KEYS.TARGET_COOKIES_PREFIX + domain;
  const result = await chrome.storage.local.get([pageKey, targetKey]);
  const page   = result[pageKey] ?? [];
  const target = result[targetKey] ?? [];
  return { page, target, merged: mergeCookieLists(page, target) };
}

export async function clearTargetCookies(domain) {
  await chrome.storage.local.remove(STORAGE_KEYS.TARGET_COOKIES_PREFIX + domain);
}

export async function mergeFromSetCookie(headers, domain) {
  const key = STORAGE_KEYS.TARGET_COOKIES_PREFIX + domain;
  const existing = (await chrome.storage.local.get(key))[key] ?? [];
  const map = new Map(existing.map(c => [c.name, c.value]));

  for (const h of headers) {
    const parsed = parseCookieHeader(h.value);
    if (parsed && !isTrackingCookie(parsed.name)) {
      map.set(parsed.name, parsed.value);
    }
  }

  const updated = Array.from(map.entries(), ([name, value]) => ({ name, value }));
  await chrome.storage.local.set({ [key]: updated });
  return updated;
}
