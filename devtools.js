// SWITCH DevTools — ES Module
import { getManagedSites, addSite, removeSite, getConfig } from './modules/config.js';
import { getStored, capture }                                          from './modules/cookies.js';
import { getActive, clear as clearRules }                              from './modules/rules.js';

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  bindEvents();

  // Live updates
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') loadAll();
  });
});

// ── Load & render all sections ─────────────────────────────────
async function loadAll() {
  await Promise.all([
    renderSites(),
    renderRules(),
    renderCookies(),
    renderStorage(),
  ]);
}

async function renderSites() {
  const sites = await getManagedSites();
  const list  = document.getElementById('sitesList');
  list.innerHTML = '';

  if (sites.length === 0) {
    list.innerHTML = '<p class="empty">No managed sites yet.</p>';
    return;
  }

  for (const domain of sites) {
    const config = await getConfig(domain);
    const row = document.createElement('div');
    row.className = 'site-row';
    row.innerHTML = `
      <div class="site-info">
        <span class="site-domain">${esc(domain)}</span>
        <span class="site-meta">
          <span class="status-dot ${config.isEnabled ? 'active' : 'off'}"></span>
          ${config.isEnabled ? 'Active' : 'Off'}
        </span>
      </div>
      <button class="btn-remove" data-domain="${esc(domain)}" title="Remove site">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4h6v2"/>
        </svg>
      </button>
    `;
    row.querySelector('.btn-remove').addEventListener('click', async (e) => {
      const d = e.target.dataset.domain;
      if (confirm(`Remove "${d}" and clear its data?`)) {
        await removeSite(d);
      }
    });
    list.appendChild(row);
  }
}

async function renderRules() {
  const rules = await getActive();
  document.getElementById('rulesOutput').textContent =
    rules.length ? JSON.stringify(rules, null, 2) : '(no active rules)';
}

async function renderCookies() {
  const sites   = await getManagedSites();
  const section = document.getElementById('cookieStatus');
  section.innerHTML = '';

  if (sites.length === 0) {
    section.innerHTML = '<p class="empty">No managed sites.</p>';
    return;
  }

  for (const domain of sites) {
    const cookies = await getStored(domain);
    const block = document.createElement('div');
    block.className = 'cookie-block';
    block.innerHTML = `
      <div class="cookie-header">
        <strong>${esc(domain)}</strong>
        <span class="badge">${cookies.length} cookie${cookies.length !== 1 ? 's' : ''}</span>
        <button class="btn-sm" data-domain="${esc(domain)}" id="refresh-${btoa(domain)}">Refresh</button>
      </div>
      <pre class="cookie-list">${cookies.length
        ? cookies.map(c => `${esc(c.name)} = ${esc(c.value.slice(0, 60))}${c.value.length > 60 ? '…' : ''}`).join('\n')
        : '(none)'
      }</pre>
    `;
    block.querySelector('.btn-sm').addEventListener('click', async (e) => {
      const d = e.target.dataset.domain;
      e.target.disabled = true;
      await capture(d);
      e.target.disabled = false;
    });
    section.appendChild(block);
  }
}

async function renderStorage() {
  const all = await chrome.storage.local.get(null);
  document.getElementById('storageOutput').textContent =
    JSON.stringify(all, null, 2);
}

// ── Event binding ─────────────────────────────────────────────
function bindEvents() {
  // Add site form
  document.getElementById('addSiteForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input  = document.getElementById('newSiteInput');
    const domain = input.value.trim().toLowerCase().replace(/^https?:\/\//, '');
    if (!domain) return;
    await addSite(domain);
    input.value = '';
  });

  // Refresh rules button
  document.getElementById('refreshRules').addEventListener('click', renderRules);

  // Clear all data
  document.getElementById('clearStorage').addEventListener('click', async () => {
    if (!confirm('Clear ALL SWITCH data? This cannot be undone.')) return;
    await clearRules();
    await chrome.storage.local.clear();
  });

  // Export storage
  document.getElementById('exportStorage').addEventListener('click', async () => {
    const all  = await chrome.storage.local.get(null);
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `switch-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ── Utils ─────────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
