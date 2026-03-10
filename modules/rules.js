// declarativeNetRequest dynamic rule management
import { SWITCHIT_CONSTANTS } from '../constants.js';

const { RULE_IDS, LOCALHOST_RE } = SWITCHIT_CONSTANTS;
const REDIRECT_IDS = RULE_IDS.REDIRECT;
const ALL_IDS = [...REDIRECT_IDS, RULE_IDS.COOKIE_INJECT];

// ── Rule builders ─────────────────────────────────────────────

function esc(domain) {
  return domain.replace(/\./g, '\\.');
}

// WS/WSS redirect is handled by content_ws.js (MAIN world injection).
// declarativeNetRequest does not support websocket redirect actions.
function buildRedirectRule(ruleId, original, target) {
  const isLocal = LOCALHOST_RE.test(target);
  return {
    id: ruleId, priority: 100,
    action: {
      type: 'redirect',
      redirect: {
        regexSubstitution: isLocal ? `http://${target}\\1` : `\\1://${target}\\2`,
      },
    },
    condition: {
      regexFilter: isLocal
        ? `^https?://${esc(original)}(.*)$`
        : `^(https?)://${esc(original)}(.*)$`,
      resourceTypes: ['xmlhttprequest', 'main_frame', 'sub_frame'],
    },
  };
}

function buildCookieRule(targetApi, cookieString) {
  return {
    id: RULE_IDS.COOKIE_INJECT,
    priority: 101,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Cookie', operation: 'set', value: cookieString }],
    },
    condition: {
      requestDomains: [targetApi.split(':')[0]],
      resourceTypes: ['xmlhttprequest', 'main_frame', 'sub_frame', 'websocket'],
    },
  };
}

/**
 * Build rule set from a pairs array.
 * pairs: [{ type: 'http'|'ws', original, target }, ...]
 */
function buildRules(pairs, cookies) {
  const rules = [];

  pairs.slice(0, REDIRECT_IDS.length).forEach((pair, i) => {
    if (!pair.original || !pair.target) return;
    if (pair.type === 'ws') return; // handled by content_ws.js
    rules.push(buildRedirectRule(REDIRECT_IDS[i], pair.original, pair.target));
  });

  const cookieTarget = pairs.find(p => p.target)?.target;
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  if (cookieTarget && cookieString) {
    rules.push(buildCookieRule(cookieTarget, cookieString));
  }

  return rules;
}

// ── Public API ────────────────────────────────────────────────

export async function apply(pairs, cookies) {
  const rules = buildRules(pairs, cookies);
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: ALL_IDS,
    addRules: rules,
  });
  console.log(`[rules] applied ${rules.length} rule(s)`);
}

export async function updateCookieOnly(targetApi, cookies) {
  const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  if (!cookieString) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_IDS.COOKIE_INJECT],
    });
    return;
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_IDS.COOKIE_INJECT],
    addRules: [buildCookieRule(targetApi, cookieString)],
  });
  console.log(`[rules] cookie rule updated for ${targetApi} (${cookies.length} cookies)`);
}

export async function clear() {
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ALL_IDS });
  console.log('[rules] cleared');
}

export async function getActive() {
  return chrome.declarativeNetRequest.getDynamicRules();
}
