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

Cookies are captured from the frontend domain on page load and injected into every redirected request, so authentication flows transparently to the new backend.

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

content_ws.js          Injected into MAIN world at document_start.
                       Overrides window.WebSocket to apply WS redirect rules.

content_bridge.js      Isolated-world counterpart. Reads config from
                       chrome.storage and pushes WS rules to content_ws.js
                       via postMessage + sessionStorage.

modules/config.js      Site list and per-domain config CRUD.
modules/cookies.js     Cookie capture and merge (including Set-Cookie headers).
modules/rules.js       DNR dynamic rule builder and applier.

devtools.html/js       Debug panel: managed sites, active DNR rules,
                       cookie status, storage inspector.
```

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

① content_ws.js injected at document_start (MAIN world) overrides
  window.WebSocket — rewrites the URL before the native constructor runs.

② content_bridge.js (isolated world) reads WS rules from chrome.storage
  and pushes them to content_ws.js via postMessage on load and on change.

③ sessionStorage caches rules so content_ws.js can read them synchronously
  on the next navigation before any page scripts execute.

④ background.js installs a DNR redirect rule (host rewrite) + a separate
  modifyHeaders rule that injects captured cookies into every request
  reaching the target domain.
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

- **Single active domain** — DNR rule IDs are shared; only the last enabled domain's rules are in effect at a time
- **WS timing** — WebSocket rules must be in place before the page initiates a connection; a page reload is required after first-time configuration
- **Popup lifecycle** — Chrome closes the popup on tab navigation (standard extension behavior)
