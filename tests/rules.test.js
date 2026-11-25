import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRedirectRule, buildCookieRule, buildRules } from '../modules/rules.js';

test('buildRedirectRule anchors host boundary so lookalike domains never match', () => {
  const localRule = buildRedirectRule(1, 'api.example.com', 'localhost:3000');
  const re = new RegExp(localRule.condition.regexFilter);

  assert.equal(re.test('https://api.example.com'), true);
  assert.equal(re.test('https://api.example.com/v1/users'), true);
  assert.equal(re.test('https://api.example.com?foo=1'), true);
  assert.equal(re.test('https://api.example.com.evil.com/v1'), false);
  assert.equal(re.test('https://api.example.com:8443/v1'), false);
  assert.equal(localRule.action.redirect.regexSubstitution, 'http://localhost:3000\\1');

  const remoteRule = buildRedirectRule(2, 'api.example.com', 'staging.example.com');
  assert.equal(remoteRule.action.redirect.regexSubstitution, '\\1://staging.example.com\\2');
});

test('buildCookieRule strictly anchors scheme and host:port for HTTP and WS', () => {
  const rule = buildCookieRule(10, 'localhost:3000', 'sid=abc');
  const re = new RegExp(rule.condition.regexFilter);

  assert.equal(re.test('http://localhost:3000/v1/me'), true);
  assert.equal(re.test('ws://localhost:3000/stream'), true);
  assert.equal(re.test('http://localhost:3000'), true);
  assert.equal(re.test('http://localhost:30001/v1'), false);
  assert.equal(re.test('https://other.com/?redirect=http://localhost:3000/'), false);
  assert.deepEqual(rule.condition.resourceTypes, ['xmlhttprequest', 'websocket']);
});

test('buildRules skips disabled pairs and generates cookie rules for WS-only targets', () => {
  const { rules, realDomainWarnings } = buildRules([
    {
      domain: 'app.example.com',
      config: {
        isEnabled: true,
        pairs: [
          { id: '1', type: 'http', original: 'api.example.com', target: 'localhost:3000', enabled: true },
          { id: '2', type: 'http', original: 'disabled.example.com', target: 'localhost:4000', enabled: false },
          { id: '3', type: 'ws',   original: 'ws.example.com', target: 'ws-staging.example.com', enabled: true },
        ],
      },
      cookies: [{ name: 'sid', value: 'token123' }],
    },
  ]);

  const redirects = rules.filter(r => r.action.type === 'redirect');
  const cookieRules = rules.filter(r => r.action.type === 'modifyHeaders');

  // Only enabled HTTP pair creates a DNR redirect rule
  assert.equal(redirects.length, 1);
  assert.match(redirects[0].condition.regexFilter, /api\\\.example\\\.com/);

  // Both localhost:3000 (HTTP) and ws-staging.example.com (WS-only) receive cookie rules
  assert.equal(cookieRules.length, 2);
  assert.equal(realDomainWarnings.length, 1);
  assert.equal(realDomainWarnings[0].target, 'ws-staging.example.com');
});
