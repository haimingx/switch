// declarativeNetRequest dynamic rule management
import { SWITCHIT_CONSTANTS } from '../constants.js';

const { LOCALHOST_RE } = SWITCHIT_CONSTANTS;

// ── Rule builders ─────────────────────────────────────────────

// Escape every regex metacharacter so the domain is matched literally.
function esc(domain) {
  return domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isLocal(host) {
  return LOCALHOST_RE.test(host.split(':')[0]);
}

// WS/WSS redirect is handled by content_ws.js (MAIN world injection).
// declarativeNetRequest does not support websocket redirect actions.
function buildRedirectRule(ruleId, original, target) {
  const local = isLocal(target);
  return {
    id: ruleId, priority: 100,
    action: {
      type: 'redirect',
      redirect: {
        regexSubstitution: local ? `http://${target}\\1` : `\\1://${target}\\2`,
      },
    },
    condition: {
      regexFilter: local
        ? `^https?://${esc(original)}(.*)$`
        : `^(https?)://${esc(original)}(.*)$`,
      resourceTypes: ['xmlhttprequest', 'main_frame', 'sub_frame'],
    },
  };
}

function buildCookieRule(ruleId, targetApi, cookieString) {
  const local = isLocal(targetApi);
  return {
    id: ruleId,
    priority: 101,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Cookie', operation: 'set', value: cookieString }],
    },
    condition: {
      // For IP:port targets, urlFilter scheme+port combos are unsupported in Chrome DNR.
      // Use plain substring match for localhost, wildcard pattern for named hosts.
      urlFilter: local ? targetApi : `*://${targetApi}/*`,
      // Cookie injection only targets API traffic (XHR/fetch + WS handshake).
      // main_frame/sub_frame are intentionally excluded so top-level navigations to a
      // real-domain target keep their own legitimate cookies (see v2 plan, problem 5).
      resourceTypes: ['xmlhttprequest', 'websocket'],
    },
  };
}

// ── Public API ────────────────────────────────────────────────

/**
 * Rebuild the ENTIRE dynamic ruleset from the full set of enabled sites in one
 * atomic update. Rule IDs are assigned fresh each pass, so multiple sites/pairs
 * never collide on a fixed ID (the v1 design only allowed one site at a time).
 *
 * @param {Array<{domain:string, config:object, cookies:Array<{name,value}>}>} sites
 */
export async function reconcile(sites) {
  const rules = [];
  let id = 1;

  // One redirect rule per valid HTTP pair across all enabled sites.
  for (const { config } of sites) {
    for (const pair of config.pairs ?? []) {
      if (pair.type === 'ws') continue; // WS handled by content_ws.js
      if (!pair.original || !pair.target) continue;
      rules.push(buildRedirectRule(id++, pair.original, pair.target));
    }
  }

  // One cookie-inject rule per distinct HTTP target (last site wins if two
  // frontends map to the same target — an unusual edge case).
  const cookieByTarget = new Map();
  for (const { domain, config, cookies } of sites) {
    if (!cookies.length) continue;
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    if (!cookieString) continue;
    const names = cookies.map(c => c.name);
    for (const pair of config.pairs ?? []) {
      if (pair.type === 'ws' || !pair.target) continue;
      cookieByTarget.set(pair.target, { cookieString, names, source: domain });
    }
  }
  for (const [target, { cookieString, names, source }] of cookieByTarget) {
    rules.push(buildCookieRule(id++, target, cookieString));
    // Real-domain targets get their own Cookie header fully replaced by the
    // captured session (DNR `operation: set`). Surface this clearly in the SW
    // console — only cookie names are logged, never values. localhost/IP
    // targets have no cookies of their own, so they're not flagged.
    if (!isLocal(target)) {
      console.warn(
        `[rules] Cookie override on real-domain target "${target}"\n` +
        `        source page : ${source}\n` +
        `        injecting   : ${names.length} cookie(s) — ${names.join(', ')}\n` +
        `        effect      : these REPLACE the target's own Cookie header on ` +
        `xmlhttprequest/websocket requests (its existing cookies are not sent)`
      );
    }
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
