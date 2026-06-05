// SWITCH Popup — ES Module, event-driven
import { SWITCHIT_CONSTANTS }              from './constants.js';
import { isManaged, addSite, getConfig, setConfig, getObservedApis, inferApiDomain, removeObservedApi } from './modules/config.js';
import { getStored }                       from './modules/cookies.js';

const { DOMAIN_RE, LOCALHOST_RE } = SWITCHIT_CONSTANTS;

const el = id => document.getElementById(id);

let currentDomain = null;
let isUserEditing = false;
let currentFilter = null; // null | 'manual' | 'scanned'

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  currentDomain = await getActiveTabDomain();
  await render();
  bindStaticEvents();
  subscribeStorage();
});

function subscribeStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const relevant = [
      'managed_sites',
      `config.${currentDomain}`,
      `cookies.${currentDomain}`,
      `observed_apis.${currentDomain}`,
    ];
    if (Object.keys(changes).some(k => relevant.includes(k))) {
      render();
    }
  });
}

// ── Render ────────────────────────────────────────────────────
async function render() {
  if (!currentDomain) { showView('unsupported'); return; }

  const managed = await isManaged(currentDomain);
  if (!managed) {
    el('addSiteDomain').textContent = currentDomain;
    showView('addsite');
    return;
  }

  const [config, cookies, observed] = await Promise.all([
    getConfig(currentDomain),
    getStored(currentDomain),
    getObservedApis(currentDomain),
  ]);

  el('currentDomain').textContent = currentDomain;

  const hasCookies = cookies.length > 0;
  el('cookieDivider').style.display = hasCookies ? '' : 'none';
  el('cookieLabel').style.display   = hasCookies ? '' : 'none';
  el('cookieCount').style.display   = hasCookies ? '' : 'none';
  if (hasCookies) {
    el('cookieCount').textContent = cookiePreview(cookies);
    el('cookieCount').title       = cookies.map(c => c.name).join('\n');
  }
  el('toggleSwitch').checked      = config.isEnabled;

  if (!isUserEditing) {
    const observedDomains = new Set(observed.map(o => o.domain));
    const savedOriginals  = new Set((config.pairs ?? []).map(p => p.original).filter(Boolean));

    const manualPairs = (config.pairs ?? []).map(p => ({
      ...p,
      _manual:  true,
      _scanned: p.original ? observedDomains.has(p.original) : false,
    }));
    const scannedOnlyPairs = observed
      .filter(o => !savedOriginals.has(o.domain))
      .map(o => ({ type: o.type, original: o.domain, target: '', _manual: false, _scanned: true }));

    const allPairs = [...manualPairs, ...scannedOnlyPairs];

    el('countManual').textContent  = manualPairs.length;
    el('countScanned').textContent = allPairs.filter(p => p._scanned).length;
    el('filterManual').classList.toggle('active',  currentFilter === 'manual');
    el('filterScanned').classList.toggle('active', currentFilter === 'scanned');

    const visible = currentFilter === 'manual'  ? allPairs.filter(p => p._manual)
                  : currentFilter === 'scanned' ? allPairs.filter(p => p._scanned)
                  : allPairs;
    renderPairs(visible);
  }

  showView('main');
}

function showView(name) {
  el('addsite-container').style.display = name === 'addsite' ? 'flex' : 'none';
  el('main-content').style.display      = name === 'main'    ? 'flex' : 'none';
}

// ── Pair cards ────────────────────────────────────────────────
const REMOVE_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M8 12H16M12 21C7.029 21 3 16.971 3 12S7.029 3 12 3s9 4.029 9 9-4.029 9-9 9z"/>
</svg>`;

function renderPairs(pairs) {
  const container = el('protocolPairs');
  container.innerHTML = '';
  let savedIdx = 0;
  pairs.forEach((pair, i) => {
    const isManual = !!pair._manual;
    const currentSavedIdx = isManual ? savedIdx++ : -1;

    const card = document.createElement('div');
    card.className = 'protocol-pair';
    card.dataset.index = i;
    card.dataset.manual = isManual ? '1' : '0';

    const tags = [
      pair._manual  ? `<span class="pair-tag tag-manual">MANUAL</span>`  : '',
      pair._scanned ? `<span class="pair-tag tag-scanned">SCANNED</span>` : '',
    ].join('');
    const fromPlaceholder = isManual ? '' : (pair.type === 'http'
      ? escAttr(inferApiDomain(currentDomain))
      : 'ws.example.com');
    // Injecting cookies into a real (non-localhost) target overwrites that
    // domain's own Cookie header. Warn the user; localhost/IP targets are safe.
    const targetHost = (pair.target || '').split(':')[0];
    const realTargetWarn = !!pair.target && !LOCALHOST_RE.test(targetHost);

    card.innerHTML = `
      <div class="pair-header">
        <div class="pair-left">
          <div class="pair-type-wrap">
            <select class="pair-type-select" data-field="type"${pair._scanned ? ' disabled' : ''}>
              <option value="http"${pair.type === 'http' ? ' selected' : ''}>HTTP/S</option>
              <option value="ws"${pair.type === 'ws' ? ' selected' : ''}>WS/WSS</option>
            </select>
            <svg class="pair-type-chevron" width="9" height="9" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </div>
          ${tags}
        </div>
        <button class="pair-remove" title="Remove rule">
          ${REMOVE_ICON_SVG}
        </button>
      </div>
      <div class="info-grid">
        <span class="info-cell-label">From</span>
        <input class="info-cell-input" data-field="original"
               placeholder="${fromPlaceholder}" autocomplete="off"
               value="${escAttr(pair.original)}">
        <div class="info-row-divider"></div>
        <span class="info-cell-label">To</span>
        <input class="info-cell-input" data-field="target"
               placeholder=""
               value="${escAttr(pair.target)}">
      </div>
      ${realTargetWarn ? `<div class="pair-warning" style="margin-top:6px;font-size:11px;line-height:1.4;color:#b8860b;"
        title="Captured cookies are written as the full Cookie header on API/WS requests to this target, replacing the target domain's own cookies.">
        &#9888; Real-domain target: its existing cookies will be overwritten on API requests.</div>` : ''}
    `;


    // Auto-save on input (debounced)
    card.querySelectorAll('.info-cell-input').forEach(input => {
      input.addEventListener('focus', () => { isUserEditing = true; });
      input.addEventListener('blur',  () => { isUserEditing = false; });
      input.addEventListener('input', () => {
        const extracted = extractDomain(input.value);
        if (extracted !== input.value) input.value = extracted;
        validateInput(input);
        scheduleAutoSave();
      });
    });

    // Remove button
    card.querySelector('.pair-remove').addEventListener('click', async () => {
      if (!isManual) {
        await removeObservedApi(currentDomain, pair.original);
      } else {
        const config = await getConfig(currentDomain);
        const updated = config.pairs.filter((_, idx) => idx !== currentSavedIdx);
        await setConfig(currentDomain, { pairs: updated });
      }
    });

    // Type select — immediate save (only for saved pairs)
    card.querySelector('.pair-type-select').addEventListener('change', async (e) => {
      if (pair._scanned) return;
      const config = await getConfig(currentDomain);
      const updated = config.pairs.map((p, idx) =>
        idx === currentSavedIdx ? { ...p, type: e.target.value } : p
      );
      await setConfig(currentDomain, { pairs: updated });
    });

    container.appendChild(card);
  });
}

// ── Domain extraction ─────────────────────────────────────────
function extractDomain(raw) {
  const v = raw.trim();
  if (!v) return v;
  try {
    // Add a scheme if missing so URL() can parse it
    const url = new URL(/^[a-z][a-z\d+\-.]*:\/\//i.test(v) ? v : `https://${v}`);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return v; // Not a parseable URL — leave as-is
  }
}

// ── Auto-save (debounce 800ms) ────────────────────────────────
let _autoSaveTimer = null;

function scheduleAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => autoSavePairs(), 800);
}

async function autoSavePairs() {
  const cards = el('protocolPairs').querySelectorAll('.protocol-pair');
  const edits = [];
  let hasError = false;

  cards.forEach(card => {
    const isManual = card.dataset.manual === '1';
    const type     = card.querySelector('[data-field="type"]').value;
    const original = card.querySelector('[data-field="original"]').value.trim();
    const target   = card.querySelector('[data-field="target"]').value.trim();
    if (!isManual && !target) return; // unconfirmed SCANNED — skip
    if (!validateDomain(original) || !validateDomain(target)) hasError = true;
    // Reject self-loops (original === target would redirect a host to itself).
    if (original && target && original === target) {
      hasError = true;
      card.querySelector('[data-field="target"]')?.classList.add('input-error');
    }
    edits.push({ type, original, target });
  });

  if (hasError) return;

  // Merge edits into existing config.pairs using type|original as dedup key.
  // This correctly handles all filter views: hidden MANUAL pairs are preserved,
  // and MANUAL+SCANNED cards are updated (not duplicated) when visible in SCANNED filter.
  const existing = await getConfig(currentDomain);
  const byKey = new Map(
    (existing.pairs ?? []).map(p => [`${p.type}|${p.original}`, { type: p.type, original: p.original, target: p.target }])
  );
  edits.forEach(p => byKey.set(`${p.type}|${p.original}`, { type: p.type, original: p.original, target: p.target }));

  await setConfig(currentDomain, { pairs: [...byKey.values()] });
  isUserEditing = false;

  // Brief green flash on saved inputs
  cards.forEach(card => {
    card.querySelectorAll('.info-cell-input').forEach(input => {
      input.classList.add('saved');
      setTimeout(() => input.classList.remove('saved'), 1000);
    });
  });
}

// ── Static event binding ──────────────────────────────────────
function bindStaticEvents() {
  el('addSiteBtn').addEventListener('click', async () => {
    if (!currentDomain) return;
    await addSite(currentDomain);
  });

  el('toggleSwitch').addEventListener('change', async (e) => {
    await setConfig(currentDomain, { isEnabled: e.target.checked });
  });

  // Scan: re-capture cookies without page reload
  el('scanCookies').addEventListener('click', async () => {
    const btn = el('scanCookies');
    btn.classList.add('spinning');
    btn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ action: 'forceCookieRead', domain: currentDomain });
      btn.classList.remove('spinning');
      btn.classList.add('done');
      setTimeout(() => btn.classList.remove('done'), 1800);
    } catch {
      btn.classList.remove('spinning');
    } finally {
      btn.disabled = false;
    }
  });

  // Refresh: reload the active tab (background auto-scans on tab load)
  el('refreshPage').addEventListener('click', async () => {
    const btn = el('refreshPage');
    btn.disabled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.tabs.reload(tab.id);
    } finally {
      btn.disabled = false;
    }
  });

  // Filter tabs
  el('filterManual').addEventListener('click', () => {
    currentFilter = currentFilter === 'manual' ? null : 'manual';
    render();
  });
  el('filterScanned').addEventListener('click', () => {
    currentFilter = currentFilter === 'scanned' ? null : 'scanned';
    render();
  });

  // Add rule
  el('addPairBtn').addEventListener('click', async () => {
    const config = await getConfig(currentDomain);
    const pairs = [...(config.pairs ?? []), { type: 'http', original: '', target: '' }];
    await setConfig(currentDomain, { pairs });
  });

  // Debug toggle
  el('debugToggle').addEventListener('change', async (e) => {
    const section = el('debugSection');
    const control = el('debugControl');
    if (e.target.checked) {
      await refreshDebugInfo();
      section.style.display = 'block';
      setTimeout(() => section.classList.add('show'), 10);
      control.classList.add('debug-expanded');
    } else {
      section.classList.remove('show');
      setTimeout(() => { section.style.display = 'none'; }, 200);
      control.classList.remove('debug-expanded');
    }
  });

}

// ── Validation ────────────────────────────────────────────────
function validateDomain(value) {
  if (!value) return true;
  if (/^https?:\/\/|^wss?:\/\//i.test(value)) return false;
  return LOCALHOST_RE.test(value) || DOMAIN_RE.test(value);
}

function validateInput(input) {
  const v = input.value.trim();
  input.classList.remove('saved');
  input.classList.toggle('input-error',   v !== '' && !validateDomain(v));
  input.classList.toggle('input-success', v !== '' &&  validateDomain(v));
}

// ── Debug ─────────────────────────────────────────────────────
async function refreshDebugInfo() {
  if (!el('debugToggle').checked) return;
  const [status, cookies] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'getStatus', domain: currentDomain }),
    getStored(currentDomain),
  ]);
  el('debugInfo').textContent = JSON.stringify({
    domain:      currentDomain,
    config:      status?.config   ?? {},
    cookieCount: cookies.length,
    cookies:     cookies.map(c => `${c.name} = ${c.value.slice(0, 60)}${c.value.length > 60 ? '…' : ''}`),
    activeRules: status?.rules    ?? [],
  }, null, 2);
}

// ── Cookie preview ────────────────────────────────────────────
function cookiePreview(cookies) {
  if (cookies.length === 0) return 'no cookies';
  const names   = cookies.map(c => c.name);
  const preview = names.slice(0, 3).join(', ');
  const extra   = names.length > 3 ? `  +${names.length - 3}` : '';
  return `${preview}${extra}`;
}

// ── Utils ─────────────────────────────────────────────────────
function escAttr(str) {
  return (str ?? '').replace(/"/g, '&quot;');
}

async function getActiveTabDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    return new URL(tab.url).hostname;
  } catch { return null; }
}
