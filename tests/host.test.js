import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHostPort,
  hostOnly,
  isLocalHost,
  validateDomain,
  extractDomain,
  inferApiDomain,
  escapeHtml,
  rewriteHttpUrl,
  rewriteWsUrl,
} from '../modules/host.js';

test('parseHostPort handles domains, ports, IPv4, and bracketed IPv6', () => {
  assert.deepEqual(parseHostPort('api.example.com'),       { host: 'api.example.com', port: '' });
  assert.deepEqual(parseHostPort('localhost:3000'),        { host: 'localhost', port: '3000' });
  assert.deepEqual(parseHostPort('127.0.0.1:8080'),        { host: '127.0.0.1', port: '8080' });
  assert.deepEqual(parseHostPort('[::1]:3000'),            { host: '[::1]', port: '3000' });
  assert.deepEqual(parseHostPort('[::1]'),                 { host: '[::1]', port: '' });
  assert.equal(hostOnly('localhost:60233'), 'localhost');
});

test('isLocalHost recognizes localhost, 127.x, 0.0.0.0, and ::1', () => {
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('localhost:3000'), true);
  assert.equal(isLocalHost('127.0.0.1:8080'), true);
  assert.equal(isLocalHost('127.10.20.30'), true);
  assert.equal(isLocalHost('0.0.0.0:9000'), true);
  assert.equal(isLocalHost('[::1]:3000'), true);
  assert.equal(isLocalHost('api.example.com'), false);
  assert.equal(isLocalHost('localhost.example.com'), false);
});

test('validateDomain accepts valid hosts/ports and rejects protocols/paths/bad ports', () => {
  assert.equal(validateDomain(''), true);
  assert.equal(validateDomain('api.example.com'), true);
  assert.equal(validateDomain('api.example.com:8443'), true);
  assert.equal(validateDomain('localhost:3000'), true);
  assert.equal(validateDomain('[::1]:3000'), true);
  assert.equal(validateDomain('https://api.example.com'), false);
  assert.equal(validateDomain('api.example.com/v1'), false);
  assert.equal(validateDomain('localhost:99999'), false);
  assert.equal(validateDomain('localhost:0'), false);
  assert.equal(validateDomain('localhost:abc'), false);
});

test('extractDomain strips scheme and path from pasted URLs', () => {
  assert.equal(extractDomain('https://api.example.com/v1/users?x=1'), 'api.example.com');
  assert.equal(extractDomain('http://localhost:3000/api'), 'localhost:3000');
  assert.equal(extractDomain('wss://ws.example.com:8443/stream'), 'ws.example.com:8443');
  assert.equal(extractDomain('api.example.com:8080'), 'api.example.com:8080');
});

test('inferApiDomain inserts -api on first label', () => {
  assert.equal(inferApiDomain('app.example.com'), 'app-api.example.com');
  assert.equal(inferApiDomain('localhost'), '');
});

test('escapeHtml escapes all five HTML-sensitive characters', () => {
  assert.equal(escapeHtml(`<img src="x" onerror='a&b'>`), '&lt;img src=&quot;x&quot; onerror=&#39;a&amp;b&#39;&gt;');
});

test('rewriteHttpUrl rewrites matching hosts and downgrades local targets to http', () => {
  const rules = [
    { original: 'api.example.com', target: 'localhost:3000' },
    { original: 'auth.example.com:8443', target: 'staging-auth.example.com' },
  ];
  assert.equal(
    rewriteHttpUrl('https://api.example.com/v1/me?a=1', rules),
    'http://localhost:3000/v1/me?a=1'
  );
  assert.equal(
    rewriteHttpUrl('https://auth.example.com:8443/login', rules),
    'https://staging-auth.example.com/login'
  );
  // Port mismatch on rule specifying origPort
  assert.equal(rewriteHttpUrl('https://auth.example.com/login', rules), null);
  // Lookalike subdomain must not match
  assert.equal(rewriteHttpUrl('https://api.example.com.evil.com/v1', rules), null);
});

test('rewriteWsUrl downgrades wss to ws for localhost and preserves wss for remote targets', () => {
  const rules = [
    { original: 'ws.example.com', target: 'localhost:3001' },
    { original: 'stream.example.com', target: 'preview-ws.example.com' },
  ];
  assert.equal(
    rewriteWsUrl('wss://ws.example.com/feed?token=1', rules),
    'ws://localhost:3001/feed?token=1'
  );
  assert.equal(
    rewriteWsUrl('wss://stream.example.com/live', rules),
    'wss://preview-ws.example.com/live'
  );
});
