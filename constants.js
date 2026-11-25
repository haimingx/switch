// SWITCH shared constants — ES Module
export const SWITCH_CONSTANTS = {
  DEFAULT_CONFIG: {
    isEnabled: false,
    pairs: [],
  },

  STORAGE_KEYS: {
    MANAGED_SITES:         'managed_sites',
    CONFIG_PREFIX:         'config.',         // config.<domain>
    COOKIES_PREFIX:        'cookies.',        // cookies.<domain>: captured from the managed page
    TARGET_COOKIES_PREFIX: 'target_cookies.', // target_cookies.<domain>: from targets' Set-Cookie
    OBSERVED_PREFIX:       'observed_apis.',  // observed_apis.<domain>
  },

  // Known tracking/analytics cookie name prefixes (case-insensitive)
  TRACKING_COOKIE_PREFIXES: [
    '_ga', '_gid', '_gat', '_gtag',
    '_fbp', '_fbc',
    '__utm', '_utm',
    '__cf_', '_cf_',
    '_hjid', '_hjsessionuser',
    'hubspotutk', '_hssc', '_hssrc', '_hstc',
    'g_state',
  ],

  // Local development hosts (port-stripped) that default to plain http:// / ws://
  LOCALHOST_HOST_RE: /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1\]|::1)$/i,

  // Hostname validation (domain, IPv4, or bracketed IPv6)
  HOSTNAME_RE: /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*|\[[0-9a-fA-F:]+\])$/,
};
