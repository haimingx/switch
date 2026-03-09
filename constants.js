// SWITCH shared constants — ES Module
export const SWITCHIT_CONSTANTS = {

  DEFAULT_CONFIG: {
    isEnabled: false,
    pairs: [],
  },

  // declarativeNetRequest rule IDs (must be unique integers)
  // IDs 1,3,4,5 = redirect pairs (up to 4); 2 = cookie inject
  RULE_IDS: {
    REDIRECT: [1, 3, 4, 5],  // one per pair slot
    COOKIE_INJECT: 2,
  },

  STORAGE_KEYS: {
    MANAGED_SITES:   'managed_sites',
    CONFIG_PREFIX:   'config.',        // config.<domain>
    COOKIES_PREFIX:  'cookies.',       // cookies.<domain>
    OBSERVED_PREFIX: 'observed_apis.', // observed_apis.<domain>
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

  // Matches localhost and 127.x.x.x with optional port
  LOCALHOST_RE: /^(127\.0\.0\.\d+|localhost)(:\d+)?$/,

  // Basic domain+port format validation (no protocol prefix)
  DOMAIN_RE: /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*(:\d+)?$/,
};
