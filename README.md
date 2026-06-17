# SWITCH

> Switch any domain's outbound connections to a target backend, with cookies auto-injected.

Built for developers who need to point a live frontend at a local or alternate backend without modifying any application code.

---

## How it works

SWITCH intercepts requests at two layers:

| Layer | Protocol | Mechanism |
|-------|----------|-----------|
| Network | HTTP/HTTPS | Chrome declarativeNetRequest (DNR) redirect rule |
| JavaScript | WS/WSS | WebSocket constructor override injected into MAIN world |

Cookies are captured from the frontend domain on page load and injected into API (XHR/fetch) and WebSocket requests to the target, so authentication flows transparently to the new backend. Top-level navigations are left untouched so a real-domain target keeps its own cookies.

---

## Installation

No build step. Plain JavaScript, loaded directly by Chrome.

**From release ZIP:**
1. Download the zip from [Releases](https://github.com/haimingx/switch/releases)
2. Open `chrome://extensions/` → enable **Developer mode**
3. Drag the zip file into the page

**From source:**
1. Open `chrome://extensions/` → enable **Developer mode**
2. Click **Load unpacked** → select this directory

---

## Usage

1. Navigate to the site you want to manage
2. Click the **SWITCH** toolbar icon → **Add this site**
3. Under **Rules**, set **From** (original domain) and **To** (target domain)
4. Toggle **TOGGLE** on

All matching HTTP and WebSocket connections will be redirected to the target domain.

### Auto-scan

While browsing a managed site, SWITCH passively observes outbound requests and surfaces new API domains as **SCANNED** suggestions. Fill in the **To** field on any suggestion to activate it.

---

## Architecture

```
background.js          Service worker. Owns rule lifecycle, cookie capture,
                       and passive request observation per tab.

popup.html/js          Extension UI. Per-site config: rule pairs, toggle,
                       cookie status, filter by MANUAL / SCANNED rules.

content_ws.js          MAIN world, document_start. Overrides window.WebSocket
                       to apply WS redirect rules. Registered dynamically
                       (chrome.scripting) ONLY on domains with an enabled WS
                       pair — every other page is left untouched.

content_bridge.js      Isolated-world counterpart. Reads config from
                       chrome.storage and pushes WS rules to content_ws.js
                       via postMessage + sessionStorage.

modules/config.js      Site list and per-domain config CRUD.
modules/cookies.js     Cookie capture and merge (including Set-Cookie headers).
modules/rules.js       DNR dynamic rule builder. reconcile() rebuilds the whole
                       ruleset from all enabled sites in one atomic update.

devtools.html/js       Debug panel: managed sites, active DNR rules,
                       cookie status, storage inspector.
```

### Design principles

- **Stateless service worker** — MV3 terminates the SW when idle, so nothing
  durable lives in memory. On every wake-up all runtime state (DNR rules,
  Set-Cookie listener, per-tab API observers) is re-derived from
  `chrome.storage` and `chrome.tabs` — never trusted from a previous run.
- **Single reconcile** — every config / cookie / site change funnels through one
  debounced `reconcile()` that rebuilds the *entire* dynamic ruleset from all
  enabled sites with freshly assigned IDs. Multiple sites coexist, removals
  leave no orphans, and there are no fixed rule IDs to collide.
- **Inject only where needed** — the WS content scripts are registered
  dynamically and exist only on domains with an enabled WS pair; every other
  page keeps a pristine native `window.WebSocket`.
- **API-scoped cookie injection** — captured cookies are set only on
  `xmlhttprequest` / `websocket` requests to the target, never on top-level
  navigations, so a real-domain target keeps its own session when browsed directly.
- **Localhost targets are plain (no TLS)** — when the target host is
  `localhost` / `127.x`, redirects downgrade the scheme to `http://` (HTTP, via
  the DNR rule) and `ws://` (WS, via the MAIN-world hook), since local dev
  servers don't serve TLS. Real-domain targets keep the original scheme.

### Interception internals

Chrome does not support WebSocket redirect via DNR, so the two protocols are handled at different layers:

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser Tab  (e.g. https://dev.example.com)                    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Page JavaScript                                        │   │
│  │                                                         │   │
│  │   fetch('https://api.example.com/data')  ─────────────────────────► Chrome Network
│  │                                          ④ DNR rewrites host       │
│  │                                            + injects Cookie        ▼
│  │                                                         │   https://localhost:3000/data
│  │                                                         │
│  │   new WebSocket('wss://ws.example.com')                 │
│  │          │                                              │
│  │          │ ① content_ws.js intercepts constructor       │
│  │          ▼                                              │
│  │   new NativeWebSocket('ws://localhost:3001')  ──────────────► Target WS server
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────┐                                   │
│  │  content_bridge.js       │  isolated world                   │
│  │  (chrome.storage → ②)   │──── postMessage ──► content_ws.js │
│  └──────────────────────────┘         ③ rules synced            │
└─────────────────────────────────────────────────────────────────┘

① content_ws.js (MAIN world) is registered dynamically (chrome.scripting)
  only on domains with an enabled WS pair. At document_start it overrides
  window.WebSocket — rewriting the URL before the native constructor runs.

② content_bridge.js (isolated world) reads WS rules from chrome.storage
  and pushes them to content_ws.js via postMessage on load and on change.

③ sessionStorage caches rules so content_ws.js can read them synchronously on
  later navigations. On the very first load of a fresh tab the rules haven't
  arrived yet, so a WebSocket created during early page parse is held by a
  bounded deferral facade (≤250ms) and connected to the resolved target once
  rules land — preserving native WebSocket semantics.

④ background.js installs a DNR redirect rule (host rewrite) + a separate
  modifyHeaders rule that injects captured cookies into API (XHR/fetch) and
  WebSocket requests reaching the target domain. Multiple enabled sites
  coexist — the full ruleset is rebuilt atomically on every change.
```

### Storage schema (`chrome.storage.local`)

```
managed_sites               string[]
config.<domain>             { isEnabled, pairs: [{ type, original, target, _manual, _scanned }] }
cookies.<domain>            { name, value }[]
observed_apis.<domain>      { domain, type }[]
```

---

## DevTools

Open via `chrome://extensions/` → SWITCH → **Extension options**

| Section | Purpose |
|---------|---------|
| Managed Sites | Add / remove domains |
| Active DNR Rules | Live declarativeNetRequest rules |
| Cookie Status | Captured cookies per domain, with manual refresh |
| Storage Inspector | Raw storage dump, exportable as JSON |
| Danger Zone | Wipe all data |

---

## Limitations

- **Enabling WS on an open tab** — dynamic content-script registration applies to future navigations; reload the tab after first enabling a WS rule on it
- **First-load WS** — on the very first load of a fresh tab, a WebSocket created during early page parse is briefly deferred (≤250ms) until rules arrive, then connected to the resolved target; once cached in the tab session, connections use the native WebSocket directly
- **Real-domain cookie target** — when the target is a real domain (not localhost/IP), captured cookies replace that domain's Cookie header on API/WS requests; this is logged in the service-worker console (`[rules] Cookie override on real-domain target …`). Local development (localhost/IP target) is unaffected
- **Popup lifecycle** — Chrome closes the popup on tab navigation (standard extension behavior)
