// Pure host, URL, validation, and escaping utilities (no Chrome API dependency)
import { SWITCH_CONSTANTS } from '../constants.js';

const { LOCALHOST_HOST_RE, HOSTNAME_RE } = SWITCH_CONSTANTS;

export function parseHostPort(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { host: '', port: '' };

  // Bracketed IPv6: [::1] or [::1]:3000
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return { host: value, port: '' };
    const host = value.slice(0, close + 1);
    const rest = value.slice(close + 1);
    if (rest.startsWith(':')) return { host, port: rest.slice(1) };
    return { host, port: '' };
  }

  const colon = value.lastIndexOf(':');
  // Bare IPv6 (multiple colons) has no port suffix
  if (colon !== -1 && value.indexOf(':') === colon) {
    return { host: value.slice(0, colon), port: value.slice(colon + 1) };
  }
  return { host: value, port: '' };
}

export function hostOnly(hostMaybePort) {
  return parseHostPort(hostMaybePort).host;
}

export function isLocalHost(hostMaybePort) {
  return LOCALHOST_HOST_RE.test(hostOnly(hostMaybePort));
}

export function isValidPort(port) {
  if (!port) return true;
  if (!/^\d+$/.test(port)) return false;
  const num = Number(port);
  return num >= 1 && num <= 65535;
}

export function validateDomain(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return true;
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)) return false;
  if (/[/?#\s]/.test(trimmed)) return false;
  const { host, port } = parseHostPort(trimmed);
  if (!host || !isValidPort(port)) return false;
  return LOCALHOST_HOST_RE.test(host) || HOSTNAME_RE.test(host);
}

export function extractDomain(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  // Strip protocol/path only when pasted as a full URL or path-containing string
  if (!/^[a-z][a-z\d+\-.]*:\/\//i.test(v) && !v.includes('/')) {
    return v;
  }
  try {
    const url = new URL(/^[a-z][a-z\d+\-.]*:\/\//i.test(v) ? v : `https://${v}`);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return v;
  }
}

export function inferApiDomain(domain) {
  const parts = String(domain ?? '').split('.');
  if (parts.length < 2) return '';
  parts[0] = `${parts[0]}-api`;
  return parts.join('.');
}

export function escRegex(literal) {
  return String(literal).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function rewriteHttpUrl(url, rules, baseHref = 'https://example.com/') {
  try {
    const parsed = new URL(url, baseHref);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    for (const rule of rules) {
      if (!rule?.original || !rule?.target) continue;
      const { host: origHost, port: origPort } = parseHostPort(rule.original);
      if (parsed.hostname.toLowerCase() !== origHost.toLowerCase()) continue;
      if (origPort && parsed.port !== origPort) continue;
      const { host: tgtHost, port: tgtPort } = parseHostPort(rule.target);
      if (isLocalHost(tgtHost)) parsed.protocol = 'http:';
      parsed.hostname = tgtHost;
      parsed.port = tgtPort;
      return parsed.toString();
    }
  } catch {
    // Invalid URL — leave untouched
  }
  return null;
}

export function rewriteWsUrl(url, rules) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null;
    for (const rule of rules) {
      if (!rule?.original || !rule?.target) continue;
      const { host: origHost, port: origPort } = parseHostPort(rule.original);
      if (parsed.hostname.toLowerCase() !== origHost.toLowerCase()) continue;
      if (origPort && parsed.port !== origPort) continue;
      const { host: tgtHost, port: tgtPort } = parseHostPort(rule.target);
      if (isLocalHost(tgtHost) && parsed.protocol === 'wss:') parsed.protocol = 'ws:';
      parsed.hostname = tgtHost;
      parsed.port = tgtPort;
      return parsed.toString();
    }
  } catch {
    // Invalid URL — leave untouched
  }
  return null;
}
