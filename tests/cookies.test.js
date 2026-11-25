import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTrackingCookie,
  dedupeAndFilter,
  parseCookieHeader,
  mergeCookieLists,
} from '../modules/cookies.js';

test('isTrackingCookie filters analytics cookies case-insensitively', () => {
  assert.equal(isTrackingCookie('_ga'), true);
  assert.equal(isTrackingCookie('_GA_12345'), true);
  assert.equal(isTrackingCookie('__cf_bm'), true);
  assert.equal(isTrackingCookie('session_id'), false);
});

test('dedupeAndFilter drops duplicates, keeps first (most-specific) value, and filters tracking', () => {
  const result = dedupeAndFilter([
    { name: '_ga', value: '1', domain: '.example.com' },
    { name: 'sid', value: 'host-specific', domain: 'app.example.com' },
    { name: 'sid', value: 'parent-domain', domain: '.example.com' },
    { name: 'csrf', value: 'xyz', domain: '.example.com' },
  ]);
  assert.deepEqual(result, [
    { name: 'sid', value: 'host-specific' },
    { name: 'csrf', value: 'xyz' },
  ]);
});

test('parseCookieHeader extracts name and value while preserving = in value', () => {
  assert.deepEqual(
    parseCookieHeader('session=abc==def; Path=/; HttpOnly; Secure'),
    { name: 'session', value: 'abc==def' }
  );
  assert.deepEqual(
    parseCookieHeader('session=; Max-Age=0; Path=/'),
    { name: 'session', value: '' }
  );
  assert.equal(parseCookieHeader('invalid_cookie_without_eq'), null);
});

test('mergeCookieLists lets target cookies override page cookies including logout empty value', () => {
  const merged = mergeCookieLists(
    [{ name: 'sid', value: 'page-token' }, { name: 'theme', value: 'dark' }],
    [{ name: 'sid', value: '' }, { name: 'target_only', value: '1' }],
  );
  assert.deepEqual(merged, [
    { name: 'sid', value: '' },
    { name: 'theme', value: 'dark' },
    { name: 'target_only', value: '1' },
  ]);
});
