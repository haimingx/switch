// declarativeNetRequest dynamic rule management
import { escRegex, isLocalHost } from './host.js';

// ── Pure rule builders (RE2-compatible: no lookaheads) ────────

// XHR/fetch are rewritten in the page by content_http.js so the target sees the
// page's real Origin; this redirect rule handles navigations and early calls
// made before the page hook receives rules.
export function buildRedirectRule(ruleId, original, target) {
  const local = isLocalHost(target);
  const origEsc = escRegex(original);
  return {
    id: ruleId,
    priority: 100,
    action: {
      type: 'redirect',
      redirect: {
        regexSubstitution: local ? `http://${target}\\1` : `\\1://${target}\\2`,
      },
    },
    condition: {
      // Anchor host boundary strictly so api.example.com never matches api.example.com.evil.com
      regexFilter: local
        ? `^https?://${origEsc}(/.*|\\?.*|#.*|$)`
        : `^(https?)://${origEsc}(/.*|\\?.*|#.*|$)`,
      resourceTypes: ['xmlhttprequest', 'main_frame', 'sub_frame'],
    },
  };
}

export function buildCookieRule(ruleId, targetApi, cookieString) {
  const tgtEsc = escRegex(targetApi);
  return {
    id: ruleId,
    priority: 101,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Cookie', operation: 'set', value: cookieString }],
    },
    condition: {
      // Strict scheme + host[:port] boundary avoids Chrome urlFilter port issues
      // and prevents substring false matches in query strings or unrelated hosts.
      regexFilter: `^(?:https?|wss?)://${tgtEsc}(?:/|\\?|#|$)`,
      // API traffic only: top-level navigations keep the target domain's own cookies.
      resourceTypes: ['xmlhttprequest', 'websocket'],
    },
  };
}

export function buildRules(sites) {
  const rules = [];
  const realDomainWarnings = [];
  let id = 1;

  for (const { config } of sites) {
    for (const pair of config.pairs ?? []) {
      if (pair.enabled === false) continue;
      if (pair.type === 'ws') continue; // WS is redirected by content_ws.js
      if (!pair.original || !pair.target) continue;
      rules.push(buildRedirectRule(id++, pair.original, pair.target));
    }
  }

  // Inject cookies for both HTTP and WS targets so dedicated WS hosts also
  // receive the managed site's session cookies during the WS handshake.
  const cookieByTarget = new Map();
  for (const { domain, config, cookies } of sites) {
    if (!cookies?.length) continue;
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    if (!cookieString) continue;
    const names = cookies.map(c => c.name);
    for (const pair of config.pairs ?? []) {
      if (pair.enabled === false || !pair.original || !pair.target) continue;
      cookieByTarget.set(pair.target, { cookieString, names, source: domain });
    }
  }

  for (const [target, { cookieString, names, source }] of cookieByTarget) {
    rules.push(buildCookieRule(id++, target, cookieString));
    if (!isLocalHost(target)) {
      realDomainWarnings.push({ target, source, names });
    }
  }

  return { rules, realDomainWarnings };
}

// ── Chrome DNR API ────────────────────────────────────────────

export async function reconcile(sites) {
  const { rules, realDomainWarnings } = buildRules(sites);

  for (const { target, source, names } of realDomainWarnings) {
    console.warn(
      `[rules] Cookie override on real-domain target "${target}"\n` +
      `        source page : ${source}\n` +
      `        injecting   : ${names.length} cookie(s) — ${names.join(', ')}\n` +
      `        effect      : replaces the target's Cookie header on xmlhttprequest/websocket requests`
    );
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(r => r.id),
    addRules: rules,
  });
  console.log(`[rules] reconciled ${rules.length} rule(s) across ${sites.length} site(s)`);
}

export async function clear() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map(r => r.id) });
  }
  console.log('[rules] cleared');
}

export async function getActive() {
  return chrome.declarativeNetRequest.getDynamicRules();
}
