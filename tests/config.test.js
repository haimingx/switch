import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePair, normalizeConfig, isPairActive, buildExportPayload, parseImportPayload } from '../modules/config.js';

test('buildExportPayload exports managed sites and configs without leaking cookies', () => {
  const payload = buildExportPayload({
    managed_sites: ['app.example.com'],
    'config.app.example.com': {
      isEnabled: true,
      pairs: [{ id: 'p1', type: 'http', original: 'api.example.com', target: 'localhost:3000', enabled: true }],
    },
    'cookies.app.example.com': [{ name: 'sid', value: 'secret-token' }],
    'target_cookies.app.example.com': [{ name: 'sid', value: 'target-secret' }],
    'observed_apis.app.example.com': [{ domain: 'api.example.com', type: 'http' }],
  });

  assert.deepEqual(payload.managed_sites, ['app.example.com']);
  assert.equal(payload['config.app.example.com'].pairs.length, 1);
  assert.equal('cookies.app.example.com' in payload, false);
  assert.equal('target_cookies.app.example.com' in payload, false);
  assert.equal('observed_apis.app.example.com' in payload, false);
});

test('normalizeConfig assigns deterministic IDs to legacy pairs without storage writes', () => {
  const raw = { isEnabled: true, pairs: [{ type: 'http', original: 'api.a.com', target: 'localhost:3000' }] };
  const first  = normalizeConfig(raw);
  const second = normalizeConfig(raw);
  assert.equal(first.pairs[0].id, 'legacy_0');
  assert.equal(first.pairs[0].id, second.pairs[0].id);
  assert.equal(first.pairs[0].enabled, true);
});

test('normalizePair assigns stable id and defaults enabled to true', () => {
  const pair = normalizePair({ type: 'http', original: ' api.example.com ', target: ' localhost:3000 ' });
  assert.ok(pair.id.length > 0);
  assert.equal(pair.type, 'http');
  assert.equal(pair.original, 'api.example.com');
  assert.equal(pair.target, 'localhost:3000');
  assert.equal(pair.enabled, true);

  const disabled = normalizePair({ id: 'fixed', type: 'ws', original: 'ws.a.com', target: 'localhost:3001', enabled: false });
  assert.equal(disabled.id, 'fixed');
  assert.equal(disabled.enabled, false);
  assert.equal(isPairActive(disabled), false);
});

test('parseImportPayload validates backup JSON and strips unknown/invalid entries', () => {
  assert.throws(() => parseImportPayload(null), /JSON object/);
  assert.throws(() => parseImportPayload({ managed_sites: [] }), /valid managed_sites/);

  const parsed = parseImportPayload({
    managed_sites: ['app.example.com', 'https://bad.com', 'app.example.com'],
    'config.app.example.com': {
      isEnabled: true,
      pairs: [{ type: 'http', original: 'api.example.com', target: 'localhost:3000' }],
    },
    'cookies.app.example.com': [{ name: 'secret', value: 'should-not-import' }],
  });

  assert.deepEqual(parsed.managed_sites, ['app.example.com']);
  assert.equal(parsed['config.app.example.com'].isEnabled, true);
  assert.equal(parsed['config.app.example.com'].pairs.length, 1);
  assert.equal('cookies.app.example.com' in parsed, false);
});
