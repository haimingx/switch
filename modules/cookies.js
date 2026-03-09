// Cookie capture, filtering, storage, and Set-Cookie handling
import { SWITCHIT_CONSTANTS } from '../constants.js';

const { STORAGE_KEYS, TRACKING_COOKIE_PREFIXES } = SWITCHIT_CONSTANTS;

// ── Helpers ───────────────────────────────────────────────────

function isTracking(name) {
  const lower = name.toLowerCase();
  return TRACKING_COOKIE_PREFIXES.some(p => lower.startsWith(p));
}

function dedupeAndFilter(cookies) {
  const seen = new Set();
  const out = [];
  for (const c of cookies) {
    const key = `${c.name}@${c.domain}`;
    if (seen.has(key) || isTracking(c.name)) continue;
    seen.add(key);
    out.push({ name: c.name, value: c.value });
  }
  return out;
}

function parseCookieHeader(str) {
  // Format: "name=value; Path=/; Secure; ..."
  const semi = str.indexOf(';');
  const pair = semi > -1 ? str.slice(0, semi) : str;
  const eq   = pair.indexOf('=');
  if (eq < 1) return null;
  return {
    name:  pair.slice(0, eq).trim(),
    value: pair.slice(eq + 1).trim(),
  };
}

// ── Public API ────────────────────────────────────────────────

/**
 * Read all cookies for `domain` from the browser, filter, and persist.
 * Returns the stored [{name, value}] array.
 */
export async function capture(domain) {
  try {
    const queries = [
      chrome.cookies.getAll({ domain: `.${domain}` }),
      chrome.cookies.getAll({ domain }),
      chrome.cookies.getAll({ url: `https://${domain}` }),
    ];

    // Also include parent-domain cookies for sub-domains
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

/** Return the stored [{name, value}] array (or [] if none). */
export async function getStored(domain) {
  const result = await chrome.storage.local.get(STORAGE_KEYS.COOKIES_PREFIX + domain);
  return result[STORAGE_KEYS.COOKIES_PREFIX + domain] ?? [];
}

/**
 * Parse `Set-Cookie` response headers and merge into the stored cookie list.
 * Returns the updated [{name, value}] array.
 */
export async function mergeFromSetCookie(headers, domain) {
  const existing = await getStored(domain);
  const map = new Map(existing.map(c => [c.name, c.value]));

  for (const h of headers) {
    const parsed = parseCookieHeader(h.value);
    if (parsed && !isTracking(parsed.name)) {
      map.set(parsed.name, parsed.value);
    }
  }

  const updated = Array.from(map.entries(), ([name, value]) => ({ name, value }));
  await chrome.storage.local.set({
    [STORAGE_KEYS.COOKIES_PREFIX + domain]: updated,
  });
  return updated;
}
