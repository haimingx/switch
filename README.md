<p align="center">
  <img src="assets/logo.svg" alt="SWITCH Logo" width="72" />
</p>

# SWITCH

Route any site's outbound HTTP and WebSocket traffic to a local or alternate backend, with session cookies auto-injected. Built as a Manifest V3 Chrome extension so you can point a live or staging frontend at local services without touching application code, proxy certificates, or `/etc/hosts`.

*Zero build step. Zero proxy certificates. Zero telemetry.*

[![Release](https://img.shields.io/github/v/release/haimingx/switch?style=flat-square&color=0fa968)](https://github.com/haimingx/switch/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/haimingx/switch/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/haimingx/switch/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/haimingx/switch?style=flat-square)](LICENSE)

[Releases](https://github.com/haimingx/switch/releases) · [Quickstart](#-quickstart) · [Architecture](#-architecture) · [Privacy & Permissions](#-privacy--permissions) · [Report an Issue](https://github.com/haimingx/switch/issues)

## <img src="docs/icons/terminal.svg" width="22" height="22" style="vertical-align: middle; margin-right: 4px;" /> Quickstart

1. Download `switch-v*.zip` from [Releases](https://github.com/haimingx/switch/releases).
2. Open `chrome://extensions/`, enable **Developer mode**, and drag the ZIP onto the page.
3. Visit any frontend tab (e.g. `https://app.example.com`), click the **SWITCH** icon, and choose **Add this site**.
4. Add a rule (`From: api.example.com` → `To: localhost:3000`) or fill **To** on a **Scanned** suggestion, then flip **TOGGLE** on.

<details>
<summary><strong>Install from source &amp; development commands</strong></summary>

Plain ES modules with zero build step and zero runtime dependencies:

```shell
git clone https://github.com/haimingx/switch.git
```

Open `chrome://extensions/` → enable **Developer mode** → click **Load unpacked** → select the repository directory.

Run unit tests (Node 20+):

```shell
node --test tests/*.test.js
```

</details>

## <img src="docs/icons/lightbulb.svg" width="22" height="22" style="vertical-align: middle; margin-right: 4px;" /> Why?

Browser-level redirect extensions hit two hard walls when routing a live frontend to a local backend:

- **Broken CORS on redirects**: a cross-origin `307` redirect taints the request origin to `Origin: null`, which backends with credentialed CORS reject.
- **No DNR WebSocket redirect**: Chrome's `declarativeNetRequest` API cannot redirect `ws://` / `wss://` connections.

**SWITCH bridges both layers cleanly inside Chrome:**

- **Real `Origin` preserved**: rewrites `fetch`, `XMLHttpRequest`, and `EventSource` URLs inside the page before requests leave the tab, so the target sees the page's real `Origin` header.
- **Native-fidelity WebSocket routing**: hooks `window.WebSocket` dynamically on enabled sites only, handles early page-load races with a bounded deferral facade (`<=250 ms`), and downgrades `wss://` to `ws://` for local targets.
- **Session continuity without pollution**: injects captured cookies on `xmlhttprequest` and `websocket` requests only (leaving top-level navigations untouched) and layers target `Set-Cookie` responses separately so login and logout on the target survive reloads.

## <img src="docs/icons/layers.svg" width="22" height="22" style="vertical-align: middle; margin-right: 4px;" /> What's Included

<table width="100%" style="border-collapse: collapse; border: none;">
  <tr style="border: none;">
    <td width="33%" valign="top" style="border: none; padding: 6px;">
      <h4>In-Page HTTP Rewrite</h4>
      <p style="font-size: 0.9em; line-height: 1.4;">Wraps <code>fetch</code>, <code>XMLHttpRequest</code>, and <code>EventSource</code> in the MAIN world to preserve real <code>Origin</code>, backed by DNR redirect fallback.</p>
    </td>
    <td width="33%" valign="top" style="border: none; padding: 6px;">
      <h4>WebSocket Routing</h4>
      <p style="font-size: 0.9em; line-height: 1.4;">Dynamically hooks <code>window.WebSocket</code> on enabled domains only, with automatic <code>wss:// → ws://</code> downgrade for <code>localhost</code>, <code>127.x</code>, and <code>[::1]</code>.</p>
    </td>
    <td width="33%" valign="top" style="border: none; padding: 6px;">
      <h4>Layered Cookie Injection</h4>
      <p style="font-size: 0.9em; line-height: 1.4;">Captures frontend cookies with host specificity, filters analytics noise, and isolates target <code>Set-Cookie</code> overlays until toggle-off.</p>
    </td>
  </tr>
  <tr style="border: none;">
    <td width="33%" valign="top" style="border: none; padding: 6px;">
      <h4>Passive API Discovery</h4>
      <p style="font-size: 0.9em; line-height: 1.4;">Observes outbound XHR and WebSocket hosts per managed tab and surfaces them as <strong>Scanned</strong> suggestions ready for a target host.</p>
    </td>
    <td width="33%" valign="top" style="border: none; padding: 6px;">
      <h4>Per-Rule Controls &amp; Badge</h4>
      <p style="font-size: 0.9em; line-height: 1.4;">Toggle individual rules without losing config, and confirm active routing at a glance via the per-tab toolbar badge.</p>
    </td>
    <td width="33%" valign="top" style="border: none; padding: 6px;">
      <h4>Settings Console &amp; Backup</h4>
      <p style="font-size: 0.9em; line-height: 1.4;">Tabbed console with structured DNR rule tables, cookie key-value inspector, Light/Dark theme, and cookie-free JSON import/export.</p>
    </td>
  </tr>
</table>

## <img src="docs/icons/cpu.svg" width="22" height="22" style="vertical-align: middle; margin-right: 4px;" /> Architecture

SWITCH runs as a stateless Manifest V3 service worker. Every configuration, cookie, or site change funnels through a single debounced `reconcile()` pass that atomically rebuilds the dynamic DNR ruleset, `Set-Cookie` listener, dynamic content scripts, and tab badges from `chrome.storage.local`.

```text
Browser Tab (https://app.example.com)
  │
  ├── fetch / XHR / EventSource('https://api.example.com/v1/me')
  │     ├─► content_http.js rewrites host in-page ─► http://localhost:3000/v1/me
  │     │   (preserves real Origin: https://app.example.com)
  │     └─► DNR modifyHeaders sets Cookie header (DNR redirect stays as fallback)
  │
  └── new WebSocket('wss://ws.example.com/stream')
        ├─► content_ws.js rewrites host in-page ─► ws://localhost:3001/stream
        └─► DNR modifyHeaders sets Cookie header on WS handshake
```

### Repository layout

| Path | Contents |
| :--- | :--- |
| `background.js` | Stateless MV3 service worker: `reconcile()`, tab-scoped `Set-Cookie` capture, batched API observer, toolbar badges |
| `content_http.js` | MAIN-world `document_start` script rewriting `fetch`, `XMLHttpRequest`, and `EventSource` |
| `content_ws.js` | MAIN-world `document_start` script overriding `window.WebSocket` with bounded first-load deferral |
| `content_bridge.js` | Isolated-world bridge syncing rules from `chrome.storage.local` via `postMessage` + `sessionStorage` |
| `popup.html` / `popup.js` | Extension popup for per-site toggle, rule management, scanned suggestions, and live debug view |
| `devtools.html` / `devtools.js` | Tabbed options console (`Sites`, `Rules`, `Cookies`, `Data`) |
| `modules/` | Pure helpers (`host.js`), config & backup validation (`config.js`), cookie capture (`cookies.js`), RE2-safe DNR builder (`rules.js`) |
| `styles/` | Shared Light/Dark CSS tokens (`tokens.css`) and page stylesheets (`popup.css`, `devtools.css`) |
| `tests/` | Zero-dependency `node --test` unit suite covering host parsing, URL rewriting, cookies, config, and DNR rules |

<details>
<summary><strong>Storage schema (<code>chrome.storage.local</code>)</strong></summary>

| Key | Value |
| :--- | :--- |
| `managed_sites` | `string[]` |
| `config.<domain>` | `{ isEnabled: boolean, pairs: [{ id, type, original, target, enabled }] }` |
| `cookies.<domain>` | `{ name, value }[]` — captured from the managed frontend |
| `target_cookies.<domain>` | `{ name, value }[]` — overlay from target `Set-Cookie` responses |
| `observed_apis.<domain>` | `{ domain, type }[]` — passively discovered outbound hosts |

</details>

> [!NOTE]
> **First enable on an open tab**: Chrome applies newly registered dynamic content scripts on the next navigation. Reload the tab (or click the refresh icon in **SETTINGS**) after first enabling rules on an already-open tab.

> [!TIP]
> **Real-domain targets**: When routing to a non-localhost domain, captured cookies replace that host's `Cookie` header on `xmlhttprequest` and `websocket` requests only (logged in the service-worker console). Top-level navigations keep the target domain's own session.

## <img src="docs/icons/lock.svg" width="22" height="22" style="vertical-align: middle; margin-right: 4px;" /> Privacy & Permissions

SWITCH runs **100% locally** inside your browser:

- **Zero telemetry**: no analytics, no external requests, and no remote storage. Everything stays in `chrome.storage.local`.
- **Safe exports**: JSON configuration exports include `managed_sites` and routing rules only — session cookies are never exported.
- **Scoped script injection**: MAIN-world scripts are registered dynamically via `chrome.scripting` **only** on domains you explicitly add and enable; every other tab keeps native `fetch`, `XMLHttpRequest`, `EventSource`, and `WebSocket`.
- **Why broad host permissions exist**: SWITCH routes arbitrary user-configured frontend domains to arbitrary local or alternate backends at runtime, which requires `http://*/*`, `https://*/*`, `ws://*/*`, and `wss://*/*` alongside `cookies`, `declarativeNetRequest`, `webRequest`, `scripting`, `storage`, and `tabs`.

## <img src="docs/icons/file-text.svg" width="22" height="22" style="vertical-align: middle; margin-right: 4px;" /> License

[AGPL-3.0-or-later](LICENSE).

> [!IMPORTANT]
> If you distribute a modified build of SWITCH, for example on the Chrome Web Store or inside your organization, you must offer its complete source under the same license.

See [NOTICE](NOTICE) for the copyright notice. The name and logo are not part of the license.
