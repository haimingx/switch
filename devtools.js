// SWITCH Console / Options — ES Module
import {
  getManagedSites, addSite, removeSite, setConfig, normalizeConfig,
  buildExportPayload, parseImportPayload,
} from './modules/config.js';
import { mergeCookieLists, capture } from './modules/cookies.js';
import { getActive, clear as clearRules } from './modules/rules.js';
import { extractDomain, validateDomain, escapeHtml } from './modules/host.js';
import { SWITCH_CONSTANTS } from './constants.js';

const { STORAGE_KEYS } = SWITCH_CONSTANTS;

let _toastTimer = null;
let _reloadTimer = null;
let _showRawRules = false;

function showToast(message, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const manifest = chrome.runtime.getManifest?.();
  if (manifest?.version) {
    document.getElementById('versionText').textContent = `v${manifest.version_name || manifest.version}`;
  }

  bindTabs();
  bindEvents();
  loadAll();

  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area !== 'local') return;
    clearTimeout(_reloadTimer);
    _reloadTimer = setTimeout(() => loadAll(), 100);
  });
});

// Single storage IPC feeds all 4 tabs consistently
async function loadAll() {
  const [all, rules] = await Promise.all([
    chrome.storage.local.get(null),
    getActive(),
  ]);
  const sites = all[STORAGE_KEYS.MANAGED_SITES] ?? [];
  renderSites(sites, all);
  renderRulesList(rules);
  renderCookies(sites, all);
  renderStorage(all);
}

// ── Tabs (ARIA tablist with Left/Right keyboard navigation) ───
function bindTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];

  function activate(tab) {
    for (const t of tabs) {
      const selected = t === tab;
      t.setAttribute('aria-selected', String(selected));
      t.tabIndex = selected ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !selected;
    }
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (e) => {
      let next = null;
      if (e.key === 'ArrowRight') next = tabs[(index + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (!next) return;
      e.preventDefault();
      activate(next);
      next.focus();
    });
  });

  document.getElementById('brandHome').addEventListener('click', () => activate(tabs[0]));
}

// ── Panel 1: Managed Sites ────────────────────────────────────
function renderSites(sites, all) {
  document.getElementById('sitesCount').textContent = String(sites.length);
  const list = document.getElementById('sitesList');
  list.innerHTML = '';

  if (sites.length === 0) {
    list.innerHTML = '<p class="empty">No managed sites yet.</p>';
    return;
  }

  for (const domain of sites) {
    const config = normalizeConfig(all[STORAGE_KEYS.CONFIG_PREFIX + domain]);
    const validPairs = (config.pairs ?? []).filter(p => p.original || p.target);

    const routesHtml = validPairs.length
      ? `<div class="site-routes">${validPairs.map(p => `
          <div class="route-line${p.enabled === false ? ' is-off' : ''}">
            <span class="route-proto ${p.type === 'ws' ? 'ws' : 'http'}">${p.type === 'ws' ? 'WS' : 'HTTP'}</span>
            <span>${escapeHtml(p.original || '—')}</span>
            <span class="route-arrow">→</span>
            <span>${escapeHtml(p.target || '—')}</span>
          </div>`).join('')}</div>`
      : '<div class="site-empty-routes">No rules configured</div>';

    const row = document.createElement('div');
    row.className = 'site-row';
    row.innerHTML = `
      <div class="site-main">
        <div class="site-head">
          <span class="status-dot ${config.isEnabled ? 'active' : ''}" aria-hidden="true"></span>
          <span class="site-domain">${escapeHtml(domain)}</span>
        </div>
        ${routesHtml}
      </div>
      <div class="site-controls">
        <label class="toggle toggle-sm" title="Toggle site">
          <input type="checkbox" class="site-toggle" role="switch" aria-label="Toggle ${escapeHtml(domain)}"${config.isEnabled ? ' checked' : ''}>
          <span class="toggle-track"></span>
        </label>
        <button class="btn-remove" type="button" data-domain="${escapeHtml(domain)}" title="Remove site" aria-label="Remove ${escapeHtml(domain)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
        </button>
      </div>
    `;

    row.querySelector('.site-toggle').addEventListener('change', async (e) => {
      await setConfig(domain, { isEnabled: e.target.checked });
    });

    row.querySelector('.btn-remove').addEventListener('click', async (e) => {
      const targetDomain = e.currentTarget.dataset.domain;
      if (confirm(`Remove "${targetDomain}" and clear its data?`)) {
        await removeSite(targetDomain);
        showToast(`Removed ${targetDomain}`);
      }
    });

    list.appendChild(row);
  }
}

// ── Panel 2: Active DNR Rules (Structured Table + Raw JSON) ───
function summarizeRule(rule) {
  const isRedirect = rule.action?.type === 'redirect';
  const filter = rule.condition?.regexFilter || rule.condition?.urlFilter || '—';
  if (isRedirect) {
    return {
      kind: 'redirect',
      label: 'Redirect',
      match: filter,
      detail: rule.action.redirect?.regexSubstitution || rule.action.redirect?.url || '—',
    };
  }
  const header = rule.action?.requestHeaders?.[0];
  const cookieCount = header?.value ? header.value.split('; ').filter(Boolean).length : 0;
  return {
    kind: 'cookie',
    label: 'Cookie',
    match: filter,
    detail: `${cookieCount} cookie${cookieCount === 1 ? '' : 's'} injected`,
  };
}

function renderRulesList(rules) {
  document.getElementById('rulesCount').textContent = String(rules.length);
  document.getElementById('rulesSummary').textContent =
    `${rules.length} active declarativeNetRequest rule${rules.length === 1 ? '' : 's'}`;

  const rawPre = document.getElementById('rulesOutput');
  rawPre.textContent = rules.length ? JSON.stringify(rules, null, 2) : '(no active rules)';

  const wrap = document.getElementById('rulesTableWrap');
  if (rules.length === 0) {
    wrap.innerHTML = '<p class="empty">No active rules.</p>';
  } else {
    const rows = rules.map(r => {
      const s = summarizeRule(r);
      return `
        <tr>
          <td class="muted">${escapeHtml(r.id)}</td>
          <td><span class="kind-label ${s.kind}">${s.label}</span></td>
          <td class="mono">${escapeHtml(s.match)}</td>
          <td class="mono">${escapeHtml(s.detail)}</td>
        </tr>
      `;
    }).join('');
    wrap.innerHTML = `
      <table class="data-table">
        <thead>
          <tr><th>#</th><th>Action</th><th>Match</th><th>Effect</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  wrap.hidden = _showRawRules;
  rawPre.hidden = !_showRawRules;
}

async function renderRules() {
  renderRulesList(await getActive());
}

// ── Panel 3: Cookies (Structured Key-Value Ledger) ────────────
function renderCookies(sites, all) {
  const container = document.getElementById('cookieStatus');
  container.innerHTML = '';

  if (sites.length === 0) {
    container.innerHTML = '<p class="empty">No managed sites.</p>';
    return;
  }

  for (const domain of sites) {
    const page   = all[STORAGE_KEYS.COOKIES_PREFIX + domain] ?? [];
    const target = all[STORAGE_KEYS.TARGET_COOKIES_PREFIX + domain] ?? [];
    const merged = mergeCookieLists(page, target);
    const targetNames = new Set(target.map(c => c.name));

    const meta = target.length
      ? `${merged.length} total · ${page.length} page · ${target.length} target`
      : `${merged.length} cookie${merged.length === 1 ? '' : 's'}`;

    const rowsHtml = merged.length
      ? `<table class="kv-table"><tbody>${merged.map(c => `
          <tr>
            <td class="kv-name">${escapeHtml(c.name)}${targetNames.has(c.name) ? '<span class="kv-target-tag">target</span>' : ''}</td>
            <td class="kv-val">${escapeHtml(c.value || '(empty)')}</td>
          </tr>`).join('')}</tbody></table>`
      : '<p class="empty">No cookies captured.</p>';

    const block = document.createElement('div');
    block.className = 'cookie-site';
    block.innerHTML = `
      <div class="cookie-site-head">
        <div class="cookie-site-title">
          <strong>${escapeHtml(domain)}</strong>
          <span class="cookie-meta">${escapeHtml(meta)}</span>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" data-domain="${escapeHtml(domain)}">Refresh</button>
      </div>
      ${rowsHtml}
    `;

    block.querySelector('button').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const targetDomain = btn.dataset.domain;
      btn.disabled = true;
      await capture(targetDomain);
      btn.disabled = false;
      showToast(`Refreshed ${targetDomain}`);
    });

    container.appendChild(block);
  }
}

// ── Panel 4: Storage ──────────────────────────────────────────
function renderStorage(all) {
  document.getElementById('storageOutput').textContent = JSON.stringify(all, null, 2);
}

// ── Events ────────────────────────────────────────────────────
function bindEvents() {
  document.getElementById('addSiteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('newSiteInput');
    const errEl = document.getElementById('addSiteError');
    const domain = extractDomain(input.value).toLowerCase();

    if (!domain || !validateDomain(domain)) {
      errEl.textContent = 'Enter a valid domain (e.g. app.example.com).';
      errEl.classList.add('show');
      return;
    }

    errEl.classList.remove('show');
    await addSite(domain);
    input.value = '';
    showToast(`Added ${domain}`);
  });

  document.getElementById('refreshRules').addEventListener('click', renderRules);

  document.getElementById('toggleRawRules').addEventListener('click', (e) => {
    _showRawRules = !_showRawRules;
    e.currentTarget.setAttribute('aria-pressed', String(_showRawRules));
    document.getElementById('rulesTableWrap').hidden = _showRawRules;
    document.getElementById('rulesOutput').hidden = !_showRawRules;
  });

  document.getElementById('clearStorage').addEventListener('click', async () => {
    if (!confirm('Clear all SWITCH sites, rules, and cookies?')) return;
    await clearRules();
    await chrome.storage.local.clear();
    showToast('Cleared all data');
  });

  document.getElementById('exportStorage').addEventListener('click', async () => {
    const all     = await chrome.storage.local.get(null);
    const payload = buildExportPayload(all);
    const blob    = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a');
    a.href        = url;
    a.download    = `switch-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Exported configuration');
  });

  const fileInput = document.getElementById('importFileInput');
  document.getElementById('importStorage').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const sanitized = parseImportPayload(parsed);
      const count = sanitized.managed_sites.length;
      if (!confirm(`Import ${count} site configuration${count === 1 ? '' : 's'}? Existing sites with the same domain will be overwritten.`)) {
        return;
      }
      const existingSites = await getManagedSites();
      const mergedSites = [...new Set([...existingSites, ...sanitized.managed_sites])];
      await chrome.storage.local.set({ ...sanitized, managed_sites: mergedSites });
      showToast(`Imported ${count} site${count === 1 ? '' : 's'}`);
    } catch (err) {
      showToast(err.message || 'Invalid backup file', true);
    }
  });
}
