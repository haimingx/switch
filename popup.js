// SWITCH Popup — ES Module, event-driven (v2 layout + v3 stable IDs & per-rule toggles)
import {
  addSite, removeSite, getConfig, setConfig, getDomainSnapshot,
  inferApiDomain, removeObservedApi, createPairId,
} from './modules/config.js';
import { getStored, mergeCookieLists } from './modules/cookies.js';
import { extractDomain, validateDomain, escapeHtml } from './modules/host.js';

const el = id => document.getElementById(id);

let currentDomain = null;
let isUserEditing = false;
let currentFilter = null; // null | 'manual' | 'scanned'
let _saveBadgeTimer = null;
let _autoSaveTimer  = null;

// ── Init (bind listeners immediately; single storage read) ────
(async function init() {
  bindStaticEvents();
  subscribeStorage();
  currentDomain = await getActiveTabDomain();
  await render();
})().catch(err => console.error('[popup] init failed:', err));

function subscribeStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !currentDomain) return;
    const relevant = [
      'managed_sites',
      `config.${currentDomain}`,
      `cookies.${currentDomain}`,
      `target_cookies.${currentDomain}`,
      `observed_apis.${currentDomain}`,
    ];
    if (Object.keys(changes).some(k => relevant.includes(k))) {
      render();
      if (el('debugToggle').checked) refreshDebugInfo();
    }
  });
}

// ── Render (single storage IPC) ───────────────────────────────
async function render() {
  if (!currentDomain) {
    el('removeSiteBtn').hidden = true;
    showView('unsupported');
    return;
  }

  const snap = await getDomainSnapshot(currentDomain);
  if (!snap.managed) {
    el('removeSiteBtn').hidden = true;
    el('addSiteDomain').textContent = currentDomain;
    showView('addsite');
    return;
  }

  const { config, observed } = snap;
  const cookies = mergeCookieLists(snap.pageCookies, snap.targetCookies);

  el('removeSiteBtn').hidden      = false;
  el('currentDomain').textContent = currentDomain;
  el('currentDomain').title       = currentDomain;
  el('toggleSwitch').checked      = config.isEnabled;

  const hasCookies = cookies.length > 0;
  el('cookieDivider').style.display = hasCookies ? '' : 'none';
  el('cookieLabel').style.display   = hasCookies ? '' : 'none';
  el('cookieCount').style.display   = hasCookies ? '' : 'none';
  if (hasCookies) {
    el('cookieCount').textContent = cookiePreview(cookies);
    el('cookieCount').title       = cookies.map(c => c.name).join('\n');
  }

  if (!isUserEditing) {
    const observedKeys   = new Set(observed.map(o => `${o.type}|${o.domain}`));
    const savedKeys      = new Set((config.pairs ?? []).map(p => `${p.type}|${p.original}`).filter(Boolean));
    const savedOriginals = new Set((config.pairs ?? []).map(p => p.original).filter(Boolean));

    const manualPairs = (config.pairs ?? []).map(p => ({
      ...p,
      _manual:  true,
      _scanned: Boolean(p.original) && observedKeys.has(`${p.type}|${p.original}`),
    }));

    const scannedOnlyPairs = observed
      .filter(o => !savedKeys.has(`${o.type}|${o.domain}`) && !savedOriginals.has(o.domain))
      .map(o => ({
        id:       null,
        type:     o.type,
        original: o.domain,
        target:   '',
        enabled:  true,
        _manual:  false,
        _scanned: true,
      }));

    const allPairs = [...manualPairs, ...scannedOnlyPairs];

    const manualCount  = manualPairs.length;
    const scannedCount = allPairs.filter(p => p._scanned).length;
    el('countManual').textContent  = manualCount  > 0 ? String(manualCount)  : '';
    el('countScanned').textContent = scannedCount > 0 ? String(scannedCount) : '';

    el('filterManual').setAttribute('aria-pressed',  String(currentFilter === 'manual'));
    el('filterScanned').setAttribute('aria-pressed', String(currentFilter === 'scanned'));

    const visible = currentFilter === 'manual'  ? allPairs.filter(p => p._manual)
                  : currentFilter === 'scanned' ? allPairs.filter(p => p._scanned)
                  : allPairs;
    renderPairs(visible);
  }

  showView('main');
}

function showView(name) {
  el('unsupported-container').dataset.visible = String(name === 'unsupported');
  el('addsite-container').dataset.visible     = String(name === 'addsite');
  el('main-content').dataset.visible          = String(name === 'main');
}

// ── Pair cards (v2 .protocol-pair + .info-grid layout) ────────
const REMOVE_ICON_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
</svg>`;

function renderPairs(pairs) {
  const container = el('protocolPairs');
  container.innerHTML = '';

  if (pairs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-rules';
    empty.textContent = currentFilter === 'scanned' ? 'No scanned hosts' : 'No rules';
    container.appendChild(empty);
    return;
  }

  for (const pair of pairs) {
    const isManual = Boolean(pair._manual);
    const card = document.createElement('div');
    card.className = 'protocol-pair';
    card.dataset.manual = isManual ? '1' : '0';
    if (pair.id) card.dataset.pairId = pair.id;

    // Quiet typographic source indicator — avoid clunky bordered "MANUAL" boxes
    let sourceHtml = '';
    if (!isManual && pair._scanned) {
      sourceHtml = '<span class="pair-source is-scanned"><span class="pair-source-dot" aria-hidden="true"></span>Scanned</span>';
    } else if (isManual && pair._scanned) {
      sourceHtml = '<span class="pair-source">Manual · Scanned</span>';
    } else if (isManual) {
      sourceHtml = '<span class="pair-source">Manual</span>';
    }

    const fromPlaceholder = pair.type === 'ws'
      ? 'ws.example.com'
      : (inferApiDomain(currentDomain) || 'api.example.com');
    const toPlaceholder = pair.type === 'ws' ? 'localhost:3001' : 'localhost:3000';

    const toggleHtml = isManual ? `
      <label class="toggle toggle-sm" title="Enable or disable this rule">
        <input type="checkbox" class="pair-enabled" role="switch" aria-label="Enable rule"${pair.enabled !== false ? ' checked' : ''}>
        <span class="toggle-track"></span>
      </label>
    ` : '';

    card.innerHTML = `
      <div class="pair-header">
        <div class="pair-left">
          <div class="pair-type-wrap" data-proto="${pair.type}">
            <select class="pair-type-select" data-field="type" aria-label="Protocol"${pair._scanned ? ' disabled' : ''}>
              <option value="http"${pair.type === 'http' ? ' selected' : ''}>HTTP/S</option>
              <option value="ws"${pair.type === 'ws' ? ' selected' : ''}>WS/WSS</option>
            </select>
            <svg class="pair-type-chevron" width="9" height="9" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </div>
          ${sourceHtml}
        </div>
        <div class="pair-right">
          ${toggleHtml}
          <button class="pair-remove" type="button" title="Remove rule" aria-label="Remove rule">
            ${REMOVE_ICON_SVG}
          </button>
        </div>
      </div>
      <div class="info-grid">
        <span class="info-cell-label">From</span>
        <input class="info-cell-input" data-field="original" autocomplete="off" spellcheck="false"
               aria-label="Original host" placeholder="${escapeHtml(fromPlaceholder)}" value="${escapeHtml(pair.original)}">
        <div class="info-row-divider"></div>
        <span class="info-cell-label">To</span>
        <input class="info-cell-input" data-field="target" autocomplete="off" spellcheck="false"
               aria-label="Target host" placeholder="${escapeHtml(toPlaceholder)}" value="${escapeHtml(pair.target)}">
      </div>
    `;

    card.querySelectorAll('.info-cell-input').forEach(input => {
      input.addEventListener('focus', () => { isUserEditing = true; });
      input.addEventListener('blur', () => {
        if (_autoSaveTimer) {
          clearTimeout(_autoSaveTimer);
          _autoSaveTimer = null;
          autoSavePairs();
        } else {
          isUserEditing = false;
        }
      });
      input.addEventListener('input', () => {
        const extracted = extractDomain(input.value);
        if (extracted !== input.value) input.value = extracted;
        validateCard(card);
        scheduleAutoSave();
      });
    });

    const enabledToggle = card.querySelector('.pair-enabled');
    if (enabledToggle && pair.id) {
      enabledToggle.addEventListener('change', async (e) => {
        const config = await getConfig(currentDomain);
        const updated = config.pairs.map(p =>
          p.id === pair.id ? { ...p, enabled: e.target.checked } : p
        );
        await setConfig(currentDomain, { pairs: updated });
      });
    }

    card.querySelector('.pair-type-select').addEventListener('change', async (e) => {
      if (pair._scanned || !pair.id) return;
      const nextType = e.target.value === 'ws' ? 'ws' : 'http';
      e.currentTarget.closest('.pair-type-wrap').dataset.proto = nextType;
      const config = await getConfig(currentDomain);
      const updated = config.pairs.map(p =>
        p.id === pair.id ? { ...p, type: nextType } : p
      );
      await setConfig(currentDomain, { pairs: updated });
    });

    card.querySelector('.pair-remove').addEventListener('click', async () => {
      if (!isManual) {
        await removeObservedApi(currentDomain, pair.original, pair.type);
      } else if (pair.id) {
        const config = await getConfig(currentDomain);
        const updated = config.pairs.filter(p => p.id !== pair.id);
        await setConfig(currentDomain, { pairs: updated });
      }
    });

    container.appendChild(card);
  }
}

// ── Validation & Auto-save (by stable pair.id) ────────────────

function validateCard(card) {
  const origInput = card.querySelector('[data-field="original"]');
  const tgtInput  = card.querySelector('[data-field="target"]');
  const original  = origInput.value.trim();
  const target    = tgtInput.value.trim();

  const origInvalid = original !== '' && !validateDomain(original);
  const tgtInvalid  = target !== '' && !validateDomain(target);
  const selfLoop    = Boolean(original && target && original.toLowerCase() === target.toLowerCase());

  origInput.classList.toggle('input-error', origInvalid);
  tgtInput.classList.toggle('input-error',  tgtInvalid || selfLoop);

  return !(origInvalid || tgtInvalid || selfLoop);
}

function scheduleAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => {
    _autoSaveTimer = null;
    autoSavePairs();
  }, 650);
}

function flashSaveBadge(text, isError = false) {
  const badge = el('saveBadge');
  badge.textContent = text;
  badge.classList.toggle('error', isError);
  badge.classList.add('show');
  clearTimeout(_saveBadgeTimer);
  _saveBadgeTimer = setTimeout(() => badge.classList.remove('show'), 1500);
}

async function autoSavePairs() {
  const cards = [...el('protocolPairs').querySelectorAll('.protocol-pair')];
  let hasError = false;
  const editedById = new Map();
  const promoted   = [];

  for (const card of cards) {
    const isManual = card.dataset.manual === '1';
    const pairId   = card.dataset.pairId || null;
    const type     = card.querySelector('[data-field="type"]').value;
    const original = card.querySelector('[data-field="original"]').value.trim();
    const target   = card.querySelector('[data-field="target"]').value.trim();

    if (!isManual && !target) continue;
    if (!validateCard(card)) { hasError = true; continue; }

    if (isManual && pairId) {
      const enabledEl = card.querySelector('.pair-enabled');
      editedById.set(pairId, {
        id: pairId,
        type,
        original,
        target,
        enabled: enabledEl ? enabledEl.checked : true,
      });
    } else if (!isManual && original && target) {
      promoted.push({ id: createPairId(), type, original, target, enabled: true });
    }
  }

  if (hasError) {
    flashSaveBadge('Invalid host', true);
    return;
  }

  const existing = await getConfig(currentDomain);
  const nextPairs = (existing.pairs ?? []).map(p => editedById.get(p.id) ?? p);
  nextPairs.push(...promoted);

  await setConfig(currentDomain, { pairs: nextPairs });
  isUserEditing = false;

  flashSaveBadge('Saved');
  cards.forEach(card => {
    card.querySelectorAll('.info-cell-input').forEach(input => {
      if (input.value.trim()) {
        input.classList.add('saved');
        setTimeout(() => input.classList.remove('saved'), 700);
      }
    });
  });
}

// ── Static events ─────────────────────────────────────────────

function bindStaticEvents() {
  const openOptions = () => chrome.runtime.openOptionsPage();
  el('openOptionsBtn').addEventListener('click', openOptions);
  el('openOptionsFromUnsupported').addEventListener('click', openOptions);

  el('addSiteBtn').addEventListener('click', async () => {
    if (!currentDomain) return;
    await addSite(currentDomain);
  });

  el('removeSiteBtn').addEventListener('click', async () => {
    if (!currentDomain) return;
    if (confirm(`Remove "${currentDomain}" and clear its rules?`)) {
      await removeSite(currentDomain);
    }
  });

  el('toggleSwitch').addEventListener('change', async (e) => {
    await setConfig(currentDomain, { isEnabled: e.target.checked });
  });

  el('scanCookies').addEventListener('click', async () => {
    const btn = el('scanCookies');
    btn.classList.add('spinning');
    btn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ action: 'forceCookieRead', domain: currentDomain });
      btn.classList.remove('spinning');
      btn.classList.add('done');
      setTimeout(() => btn.classList.remove('done'), 1400);
    } catch {
      btn.classList.remove('spinning');
    } finally {
      btn.disabled = false;
    }
  });

  el('refreshPage').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.reload(tab.id);
  });

  // Optional toggle filter chips (neither pressed = show all)
  el('filterManual').addEventListener('click', () => {
    currentFilter = currentFilter === 'manual' ? null : 'manual';
    render();
  });
  el('filterScanned').addEventListener('click', () => {
    currentFilter = currentFilter === 'scanned' ? null : 'scanned';
    render();
  });

  // Add new rule
  el('addPairBtn').addEventListener('click', async () => {
    if (currentFilter === 'scanned') currentFilter = null;
    const config = await getConfig(currentDomain);
    const newId = createPairId();
    const pairs = [
      ...(config.pairs ?? []),
      { id: newId, type: 'http', original: '', target: '', enabled: true },
    ];
    isUserEditing = false;
    await setConfig(currentDomain, { pairs });
    await render();
    el('protocolPairs').querySelector(`[data-pair-id="${newId}"] [data-field="original"]`)?.focus();
  });

  // v2 Debug toggle
  el('debugToggle').addEventListener('change', async (e) => {
    const section = el('debugSection');
    const control = el('debugControl');
    if (e.target.checked) {
      await refreshDebugInfo();
      section.hidden = false;
      control.classList.add('debug-expanded');
    } else {
      section.hidden = true;
      control.classList.remove('debug-expanded');
    }
  });
}

// ── Debug ─────────────────────────────────────────────────────

async function refreshDebugInfo() {
  if (!el('debugToggle').checked) return;
  const [status, cookies] = await Promise.all([
    chrome.runtime.sendMessage({ action: 'getStatus', domain: currentDomain }),
    getStored(currentDomain),
  ]);
  el('debugInfo').textContent = JSON.stringify({
    domain:          currentDomain,
    isEnabled:       status?.config?.isEnabled ?? false,
    pairs:           status?.config?.pairs ?? [],
    pageCookies:     status?.pageCookieCount ?? 0,
    targetCookies:   status?.targetCookieCount ?? 0,
    injectedCookies: cookies.map(c => `${c.name}=${c.value.slice(0, 48)}${c.value.length > 48 ? '…' : ''}`),
    activeDnrRules:  status?.rules ?? [],
  }, null, 2);
}

// ── Helpers ───────────────────────────────────────────────────

function cookiePreview(cookies) {
  const names   = cookies.map(c => c.name);
  const preview = names.slice(0, 3).join(', ');
  const extra   = names.length > 3 ? ` +${names.length - 3}` : '';
  return `${preview}${extra}`;
}

async function getActiveTabDomain() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    const parsed = new URL(tab.url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.hostname;
  } catch {
    return null;
  }
}
