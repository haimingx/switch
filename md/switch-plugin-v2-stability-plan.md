# SWITCH 插件 v2 稳定性优化方案

> 状态：**方案设计阶段（仅文档，未改动功能代码）**
> 分支：`v2`（基于最新 `main`，HEAD `4042f04`）
> 适用版本：manifest `1.0.7`
> 目标：在**不改变现有功能与用户配置语义**的前提下，修复功能性 bug、提升服务稳定性、降低兼容性风险、对齐 MV3 最佳实践。

---

## 目录

1. 当前插件架构概览
2. 核心流程说明
3. 已知问题逐项分析（问题 1–5）
4. 额外发现的问题（E1–E12）
5. 问题汇总表（影响范围 / 风险等级）
6. 推荐优化方案（按问题）
7. 是否改变现有功能语义
8. 具体代码改造点
9. 测试用例设计
10. 回归验证方案
11. 分阶段实施步骤
12. 风险与回滚方案

---

## 1. 当前插件架构概览

SWITCH 是一个 Manifest V3 Chrome 扩展，用于把**受管理前端域名**发出的 API / WebSocket 流量重定向到**可配置的目标后端**，并自动注入前端域名的 Cookie 以保持会话。典型用途是把 `dev.chaintable.com` 的 API 流量切到 `localhost` 或其它后端。

### 文件结构（实际，已超出 `CLAUDE.md` 旧描述）

| 文件 | 角色 |
|---|---|
| `manifest.json` | MV3 清单。模块化 service worker；两条静态 content script（`http://*/*`、`https://*/*`）。 |
| `constants.js` | 共享常量：`DEFAULT_CONFIG`、`RULE_IDS`、`STORAGE_KEYS`、`LOCALHOST_RE`、`DOMAIN_RE`、追踪 Cookie 前缀。ES Module。 |
| `background.js` | Service worker 主体。事件监听、DNR/Cookie 规则编排、API 自动发现 observer、Set-Cookie 捕获。 |
| `modules/config.js` | 站点列表与每域名配置的读写、v1/v2 schema 迁移、observed API 列表。 |
| `modules/cookies.js` | Cookie 抓取/过滤/存储、`Set-Cookie` 合并。 |
| `modules/rules.js` | `declarativeNetRequest` 动态规则构建与应用。 |
| `content_ws.js` | **MAIN world**、`document_start`：劫持 `window.WebSocket` 做 WS 重定向。 |
| `content_bridge.js` | **isolated world**、`document_start`：从 `chrome.storage.local` 读 WS 规则，写入 `sessionStorage` 并 `postMessage` 给 MAIN world。 |
| `popup.js` / `popup.html` | 主 UI：开关、规则对（pairs）编辑、自动保存、扫描到的 API 展示。 |
| `devtools.js` / `devtools.html` | `options_page`：站点管理、规则/Cookie/存储查看、导出、清空。 |
| `rules.json` | 静态 DNR 规则集（空 `[]`，规则全部运行时动态管理）。 |

### 关键设计点

- **配置存储**：全部在 `chrome.storage.local`。键：`managed_sites`（数组）、`config.<domain>`、`cookies.<domain>`、`observed_apis.<domain>`。
- **配置模型**：每个域名 `{ isEnabled, pairs: [{ type:'http'|'ws', original, target }] }`。
- **HTTP 重定向**：通过 DNR 动态规则（`redirect` + `regexFilter`）。
- **Cookie 注入**：通过 DNR 动态规则（`modifyHeaders` / `Cookie: set`）。
- **WS 重定向**：DNR 不支持 WebSocket 重定向，改由 MAIN world 劫持 `window.WebSocket` 实现。
- **API 自动发现**：`webRequest.onBeforeRequest` 监听受管理 tab 的 xhr/websocket 请求，记录到 `observed_apis.<domain>` 供 UI 提示。
- **Set-Cookie 回写**：`webRequest.onHeadersReceived` 监听目标域响应，把 `Set-Cookie` 合并回存储的 Cookie 集合。

---

## 2. 核心流程说明

### 2.1 启用某站点 → 安装规则

`popup` 写 `config.<domain>`（`background.js:43` `storage.onChanged`）→ `applyRulesForDomain(domain)`（`background.js:183`）→ `Rules.apply(pairs, cookies)`（`modules/rules.js:77`）：

- 对每个 `http` pair 生成 redirect 规则（ID 取自 `RULE_IDS.REDIRECT = [1,3,4,5]`）。
- 生成一条 Cookie 注入规则（ID `RULE_IDS.COOKIE_INJECT = 2`）。
- `updateDynamicRules({ removeRuleIds: ALL_IDS, addRules })` 整体替换。
- 绑定目标域的 `Set-Cookie` 监听（`bindResponseListener`，`background.js:83`）。

### 2.2 页面加载 → Cookie 抓取 + observer 绑定

`tabs.onUpdated`（status `complete`，`background.js:23`）→ `Cookies.capture` → `refreshCookieRule` → `bindRequestObserver(tabId, domain)`（`background.js:136`）。

### 2.3 WS 重定向链路

`content_bridge.js`（isolated，`document_start`）异步 `chrome.storage.local.get('config.<host>')` → `pushRules()`：写 `sessionStorage['__switch_ws_rules']` + `postMessage`。`content_ws.js`（MAIN，`document_start`）**同步**读 `sessionStorage` 初始化 `wsRules`，并监听 `message` 更新；`window.WebSocket` 被替换为按 `wsRules` 改写 URL 的 wrapper。

### 2.4 SW 唤醒恢复

`background.js:14` 顶层 `restoreAllRules()`：遍历 `managed_sites`，对 `isEnabled` 的域名逐个 `applyRulesForDomain`。

---

## 3. 已知问题逐项分析

### 问题 1 — WebSocket 重定向首屏竞态

**代码定位**：`content_ws.js:6-18`、`content_bridge.js:23-25`。

**机制**：
- `content_ws.js` 在 MAIN world / `document_start` **同步**读取 `sessionStorage`。
- 规则真正来源是 `content_bridge.js` 的 `chrome.storage.local.get(...)` —— **异步**回调，回调里才写 `sessionStorage` / `postMessage`。
- `sessionStorage` 是 **per-tab、per-origin** 的会话级存储：在某个 tab 内首次打开该 origin 时为空。
- 因此存在一个时间窗：MAIN world 的 `WebSocket` 劫持虽然在最早期就安装，但此刻 `wsRules = []`。若页面早期同步脚本（解析 HTML 时）就 `new WebSocket(...)`，该连接以**原始 URL**直连，不会被重定向。
- 后续同 tab 的导航/刷新因 `sessionStorage` 已被上一轮 bridge 写入而正常。

**首屏漏改的触发条件（全部满足）**：
1. 该 origin 在当前 tab 是**首次加载**（`sessionStorage` 尚无缓存）。
2. 站点存在启用中的 **WS 规则**。
3. 页面在 bridge 的异步 `storage.get` 回调到达**之前**创建 WebSocket（早期内联脚本、框架启动即连等）。

**根因**：MV3 中 content script 没有**同步**读取扩展存储的通道；MAIN/isolated 跨 world 只能靠 `postMessage` / 共享 DOM / `sessionStorage`，而规则数据源（`chrome.storage`）天然异步。劫持安装时机（足够早）没问题，**问题是规则数据此刻还没到**。

**当前注入链路的问题**：
- 规则要经过「`storage.get`（异步）→ 写 `sessionStorage` → `postMessage` → MAIN world 接收」多跳，首跳就晚于 `document_start` 同步代码。
- `postMessage` 在 MAIN world 侧未做来源校验（见 E7），且 `sessionStorage` 页面可读写（见 E8）。

**是否可安全跳过 hook**：可以——若该域名没有任何启用的 WS 规则，则根本不应替换 `window.WebSocket`（与问题 3 一致），这样既消除竞态相关 footprint，也减少兼容性风险。

---

### 问题 2 — MV3 Service Worker 重启后 observer 丢失

**代码定位**：`_tabObservers`（`background.js:108`）、`bindRequestObserver`（`background.js:136`，仅在 `tabs.onUpdated` 内调用）、`_responseListener`/`_listeningTarget`（`background.js:80-81`）。

**机制**：
- MV3 service worker 空闲约 30s 会被终止，所有内存态（`_tabObservers` Map、`_responseListener` 引用、所有 `webRequest` 监听）随之清空。
- 唤醒后顶层 `restoreAllRules()` 会重建 **DNR 规则**，并通过 `applyRulesForDomain → bindResponseListener` 重新绑定 **Set-Cookie 监听**。
- **但 `_tabObservers` 不会恢复**：`bindRequestObserver` 只在 `tabs.onUpdated`（status `complete`）里被调用，而已经加载完成的 tab 不会再触发该事件。结果：已打开页面的 **API 自动发现静默失效**，直到用户刷新页面。

**`_responseListener` / `_listeningTarget` 是否有类似问题**：
- 部分有，但能被 `restoreAllRules` 间接修复：唤醒后会重新 `bindResponseListener`。
- **遗留缺陷**：`_listeningTarget` 只保存**单个**目标（`background.js:81/89`）。`restoreAllRules` 对多个启用域名逐个 `applyRulesForDomain` → 每次 `bindResponseListener` 都会 remove 上一个、只留**最后一个**目标的 Set-Cookie 监听。多域名/多目标时只有最后一个目标的 `Set-Cookie` 会被回写（详见 E4）。

**恢复策略分析**：
- `chrome.tabs.query({})` 在 SW 启动时**重新枚举所有 tab**，对其中 `isManaged` 的 tab 重新 `bindRequestObserver`，即可恢复自动发现，无需用户刷新。
- 这比「持久化 observer 状态到 `storage.session`」更简单也更权威——tab 是真实事实来源，observer 只是它的派生物。

**根因**：依赖内存态、且只在 tab 事件流中重建，违反 MV3「SW 可随时重启、状态需可从持久源/浏览器重新推导」的原则。

---

### 问题 3 — Content Script 注入范围过宽

**代码定位**：`manifest.json:60-72`（两条 content script 均 `matches: ["http://*/*","https://*/*"]`）。

**问题**：
- 插件在**所有** http/https 页面注入 `content_ws.js`（MAIN world）+ `content_bridge.js`。
- 即使页面没有任何规则，MAIN world 也会替换 `window.WebSocket`，扩大兼容性风险（dApp / 钱包 / 严格 CSP 页面 / 与其它扩展的 `window.WebSocket` 劫持冲突）。
- 每个页面都有一次无意义的 `storage.get`（bridge）与全局对象改写。

**能否收窄**：
- 静态 `content_scripts` 的 `matches` 写死，无法随用户配置动态变化。
- 正确做法是改用 **`chrome.scripting.registerContentScripts`** 动态注册，仅对「启用且含 WS 规则」的域名注册，并在配置变化/SW 启动时同步注册集合。其余页面 `window.WebSocket` **完全不被触碰**，天然实现「无规则页面跳过 hook」。
- 注意：只有 **WS** 路径需要 content script；HTTP/Cookie 走 DNR，不需要 content script。因此「仅用 HTTP 重定向」的站点可以**完全不注入任何 content script**，footprint 进一步降低。

**根因**：WS 劫持是全局副作用，却用「全站匹配 + 运行时无法早退」的静态注入承载。

---

### 问题 4 — `storage.onChanged` 只处理一个 config key

**代码定位**：`background.js:45`
```js
const configKey = Object.keys(changes).find(k => k.startsWith('config.'));
```

**问题**：
- 一次只处理**第一个** `config.*`。批量更新多个站点配置时，只有第一个会触发规则更新。

**更严重的连带问题（见 E1）**：即便改成遍历所有变化的 config key，**当前 DNR 规则 ID 是全局固定的**（`[1,3,4,5,2]`），`Rules.apply` 每次 `removeRuleIds: ALL_IDS` 整体替换。也就是说**同一时刻 DNR 里只能存在一个域名的规则**——后应用的域名会覆盖前一个。所以「多 config 同时变更全部生效」**不能只靠遍历解决**，必须先解决规则 ID 的多域名共存问题。

**分析**：
- 批量更新场景确实存在（导入配置、`storage.local.clear` 后恢复、多 pair 一次保存、未来多站点开关）。
- 应改为 `filter` 遍历所有 `config.*` 变化；并配合 **debounce** 合并抖动；最终统一走一次**全量 reconcile**（见方案 4/E1）。

---

### 问题 5 — Cookie 注入覆盖整个 Cookie Header

**代码定位**：`modules/rules.js:35-51`（`buildCookieRule`，`operation: 'set'`，`resourceTypes: ['xmlhttprequest','main_frame','sub_frame','websocket']`）。

**问题**：
- 对目标域的匹配请求，整体 **`set` 覆盖** `Cookie` 头。
- `localhost` / IP 目标基本没有自身 Cookie，影响小。
- 若目标是**真实域名**（该域名本身有合法登录态），注入会**覆盖**其原有 Cookie，可能导致该域被「踢下线」或会话错乱。
- 覆盖还作用于 `main_frame`/`sub_frame` 顶层导航，而 API 实际只走 `xmlhttprequest`/`websocket`，顶层导航注入既无必要又最危险。

**DNR 能否安全合并 Cookie**：
- DNR `modifyHeaders` 仅有 `set`/`append`/`remove`。`append` 对 `Cookie` 头会产生**第二个 Cookie 头**，浏览器/服务端是否拼接行为不可靠——**无法做到「按 cookie 名合并」**。
- 因此「精确合并」在 DNR 层不可行；应通过**缩小作用范围**与**区分目标类型**降低风险。

**目标**：
- 降低误覆盖真实域名 Cookie 的风险；保持本地开发代理（localhost target）场景完全可用。

---

## 4. 额外发现的问题

> 这些是在审查「额外审查点」时发现的、未在已知问题中点名但同等重要（部分**更严重**）的问题。

### E1（严重）— DNR 规则 ID 全局固定，多域名互相覆盖
`constants.js:11-14` 把 `REDIRECT=[1,3,4,5]`、`COOKIE_INJECT=2` 作为**全局**常量；`Rules.apply`（`modules/rules.js:77-84`）每次 `removeRuleIds: ALL_IDS`。**后果**：
- 同时启用多个站点时，只有**最后 apply 的域名**的规则在 DNR 中存活，其它域名静默失效。
- `restoreAllRules`（`background.js:170-181`）按序对每个启用域名 `applyRulesForDomain`，结果同样只剩最后一个。
- 禁用/删除任一站点会触发 `applyRulesForDomain → Rules.clear()`，**清空所有域名**的规则（`background.js:191`）。

这是「问题 4」和多 tab/多域名串扰的**共同根因**，必须优先解决。

### E2（中）— 删除站点未完整清理运行时状态
`removeSite`（`modules/config.js:36-46`）只删除 storage 键；依赖 `storage.onChanged` 间接 `applyRulesForDomain` 清规则，但**不会**反注册 WS content script（v2 动态注册后必须处理），也**不会**精确清掉只属于该域名的规则（在 E1 的全局 ID 下会误清全部）。

### E3（中）— 超过 4 个 pair 或 WS 占位时丢弃 HTTP 重定向
`buildRules`（`modules/rules.js:60-64`）`pairs.slice(0, 4).forEach((pair,i)=>...)` 以**数组下标**取规则 ID。若前面有 ws/空 pair 占位，下标推进但只跳过不复用，导致第 5 个及以后的 http pair 被**静默丢弃**。UI 允许「Add rule」无限添加（`popup.js:307`），易触发。

### E4（中）— Set-Cookie 监听只覆盖单一目标
`_listeningTarget`（`background.js:81-104`）只跟踪一个目标；多域名/多目标时，`Set-Cookie` 回写只对最后绑定的目标生效，其余目标的服务端续期 Cookie 不会被捕获。

### E5（中）— 缺少错误处理 / 安全降级
- `applyRulesForDomain`（`background.js:183`）、`storage.onChanged` async handler（`background.js:43`）无 `try/catch`：`updateDynamicRules` 抛错（如非法 regex）会丢失本次变更并产生未处理 rejection。
- `esc()`（`modules/rules.js:10`）只转义 `.`，其它正则元字符未处理；正常路径有 `DOMAIN_RE` 兜底，但导入/迁移数据可能绕过 UI 校验。

### E6（中低）— `cookies.onChanged` 抖动放大
`chrome.cookies.onChanged`（`background.js:36`）对任何受管理域名的 Cookie 变化都会 `capture + refreshCookieRule` → 触发一次 `updateDynamicRules`。高频 Cookie 变化（含被过滤的追踪 Cookie 仍会触发回调）会造成 DNR 频繁重写。需 debounce/合并。

### E7（中低，安全）— `postMessage` 缺少来源/结构校验
`content_ws.js:14-18` 仅判断 `e.data?.__switch === 'ws_rules'`，未校验 `e.source === window`，也无共享令牌。页面内任意脚本/子 iframe 可伪造该消息向 MAIN world hook 注入 WS 重定向规则。属「页面攻击自身」范畴、危害有限，但应加 `e.source === window` 与规则结构校验，并考虑注入期共享 nonce。

### E8（低，安全/信息泄露）— `sessionStorage` 规则页面可读写
`__switch_ws_rules`（`content_ws.js`/`content_bridge.js`）存在页面可读的 `sessionStorage`：页面 JS 可读取内部 API 目标（信息泄露），亦可预写污染。危害有限，建议至少做结构校验，长期可考虑更隐蔽通道。

### E9（中低）— WebSocket hook 保真度
`content_ws.js:38-52`：
- `WebSocket.prototype = NativeWS.prototype` 后 `prototype.constructor` 指向 `NativeWS`，`instance.constructor` 不再是 wrapper。
- 缺 `name`/`length`；不要求 `new`（`WebSocket(url)` 不抛错，native 会抛）。
- 无重复注入保护（若脚本被注入两次会层层包裹）。
建议用 `Proxy`/`Reflect.construct` 提升保真度、修正 `constructor`、补静态属性、加 `new` 校验与「已注入」哨兵。保持「返回真实 NativeWS 实例、异常透传、原型链不破坏」。

### E10（低）— `removeSite` 后 `sessionStorage` 残留
反注册 content script 后，已打开页面的 `__switch_ws_rules` 不会被清。下次该页面**不再注入** content script，hook 也不存在，影响有限；但 bridge 在仍注入的场景会自愈（每次加载按当前配置重推，禁用时推 `[]`）。

### E11（低）— 潜在重定向自环
UI 不阻止 `target === original`（`popup.js`）。若两者相同，redirect 规则可能自环。概率低，建议保存时校验。

### E12（低）— 日志含域名/目标，建议分级
`background.js`/`modules/rules.js` 的 `console.log` 含域名、目标、cookie 数量（**不含 cookie 值**，符合预期）。`devtools.js:109-113` 与 `popup.js` debug 区会展示 cookie 值，但均在显式调试入口内，可接受。建议把冗余日志收敛到统一的 `debug` 开关后，确保非调试路径不打印敏感目标信息。

---

## 5. 问题汇总表

| 编号 | 问题 | 影响范围 | 风险等级 | 是否改用户语义 |
|---|---|---|---|---|
| 1 | WS 首屏竞态 | 首次加载且含 WS 规则的页面 | **高** | 否 |
| 2 | SW 重启 observer 丢失 | 已打开的受管理 tab 的 API 自动发现 | **高** | 否 |
| 3 | content script 注入过宽 | 所有 http/https 页面 | 中 | 否 |
| 4 | onChanged 只处理一个 config | 批量配置变更 | 中 | 否 |
| 5 | Cookie 头整体覆盖 | 真实域名 target | 中（localhost 低） | 否 |
| E1 | DNR 规则 ID 全局固定，多域名覆盖 | 多站点同时启用 | **高** | 否 |
| E2 | 删除站点清理不完整 | 删除/反注册 | 中 | 否 |
| E3 | >4 pair / WS 占位丢 http 规则 | 多规则站点 | 中 | 否 |
| E4 | Set-Cookie 仅单目标 | 多目标站点 | 中 | 否 |
| E5 | 错误处理缺失 | 全局健壮性 | 中 | 否 |
| E6 | cookies.onChanged 抖动 | 高频 Cookie 站点 | 中低 | 否 |
| E7 | postMessage 无校验 | WS 规则页面 | 中低（安全） | 否 |
| E8 | sessionStorage 可读写 | WS 规则页面 | 低（安全） | 否 |
| E9 | WS hook 保真度 | 含 WS 规则页面 | 中低 | 否（更贴近原生） |
| E10 | removeSite sessionStorage 残留 | 反注册后页面 | 低 | 否 |
| E11 | 重定向自环 | 误配置 | 低 | 否 |
| E12 | 日志分级 | 运维/隐私 | 低 | 否 |

---

## 6. 推荐优化方案

> 总原则：**用户可见行为与配置语义保持不变**；优先级 = 先修正确性（E1/问题 2/问题 1），再降风险（问题 3/5、E2/E4/E5/E6），最后保真与清理（E7–E12）。

### 方案 A（核心）— DNR「全量 reconcile」取代「按域名覆盖」（解决 E1、问题 4、E2、E3、E4 的根因）

引入单一 `reconcileRules()`：
1. 读取**所有** `managed_sites` 及其 `config` / `cookies`。
2. 为每个 `isEnabled` 域名的每个有效 `http` pair 生成 redirect 规则；为每个目标生成 Cookie 注入规则。
3. **每次重建时统一重新编号**（顺序分配唯一整数 ID，因为我们整体替换，无需稳定 ID），彻底消除多域名 ID 冲突与「>4 pair 丢失」。
4. 通过 `getDynamicRules()` 拿到现存 ID，`updateDynamicRules({ removeRuleIds: existing, addRules: next })` 原子替换。
5. 同步重建 **Set-Cookie 监听**，使其覆盖**所有**启用目标（一个监听 + 目标集合过滤，或按目标集合重建 filter），解决 E4。
6. 同步 **WS content script 注册集合**（见方案 C）。

`storage.onChanged` 改为：任意 `config.*` / `cookies.*` / `managed_sites` 变化 → **debounce** 后调用一次 `reconcileRules()`（解决问题 4 与 E6 抖动）。`restoreAllRules` 改为直接调用 `reconcileRules()`。`removeSite` 后由同一路径自然清理（解决 E2 的规则部分）。

> 规模：动态规则上限远大于本场景（数千条），顺序编号安全。

### 方案 B（问题 1）— WS 首屏竞态修复

分两层，互相叠加：

1. **缩小注入范围（同方案 C）**：仅对「启用且含 WS 规则」的域名注入 MAIN world hook → 非 WS 页面零副作用，竞态面收敛到「确有 WS 规则的页面的首次加载」。
2. **首屏有界延迟代理**：MAIN world hook 在「规则尚未就绪」窗口内创建的 WebSocket，返回一个**轻量延迟代理**：先不真正连接，等 bridge 推送规则到达（或 ~250ms 超时）后再 `new NativeWS(redirectedURL)`，期间缓存 `send()`、转发事件与属性。规则到达后按命中/未命中决定目标。
   - 因为该脚本**只在确有 WS 规则的域名注入**，此延迟仅影响这些页面，footprint 最小。
   - 语义影响：`open` 事件略有延迟、早期 `send` 入队后回放——属可接受的近似；文档需注明。提供「无 WS 规则即不注入、零影响」的默认前提。

> 关于「同步预注入」：MV3 没有让 content script **同步**读取扩展存储的通道，`registerContentScripts` 只接受文件、不接受内联数据，`executeScript` 的 `injectImmediately` 不保证早于页面首脚本且受 SW 冷启动影响。因此「构造 WebSocket 前规则一定可用」无法**纯同步**保证，有界延迟代理是兼顾正确性与保真度的务实解。

### 方案 C（问题 3，配合 B/A）— 动态注册 content script

- 移除 `manifest.json` 的两条静态 `content_scripts`。
- 在 `reconcileRules()` 中计算「启用且含有效 WS pair」的域名集合，用 `chrome.scripting.registerContentScripts`（`persistAcrossSessions: true`，`world: 'MAIN'` + 一条 isolated bridge）注册/`updateContentScripts`/`unregisterContentScripts`。
- SW 启动时对齐注册集合（reconcile 内完成），解决 E2 的反注册部分与 E10。

### 方案 D（问题 2）— SW 启动恢复 observer

- 新增 `restoreObservers()`：SW 启动（reconcile 之后）`chrome.tabs.query({})`，对 `isManaged` 的 tab 重新 `bindRequestObserver`（必要时顺带 `Cookies.capture`）。
- 不持久化 observer 状态，以 `chrome.tabs` 为权威源重建——符合 MV3 最佳实践。

### 方案 E（问题 5）— Cookie 注入收敛

- `buildCookieRule` 的 `resourceTypes` 收敛为 **`['xmlhttprequest','websocket']`**，去掉 `main_frame`/`sub_frame`（顶层导航不再被覆盖 Cookie）。
- **区分 target 类型**：`localhost`/IP 目标维持现状（`set` 注入，开发代理必需）。真实域名目标：在 popup/devtools 增加**风险提示**（「将覆盖该域名原有 Cookie」），保持功能可用但让用户知情；不擅自改变默认行为。
- 文档明确：DNR 无法按名合并 Cookie，真实域名 target 属高级用法。

### 方案 F（E5/E6/E7/E9/E11/E12）— 健壮性与保真

- 所有 async 事件 handler 包 `try/catch`，DNR 写入失败时记录并安全降级（保留旧规则或清空到已知状态）。
- `cookies.onChanged` 与 reconcile 共用 debounce。
- `content_ws.js` 消息校验 `e.source === window` + 规则结构校验（+ 可选注入期 nonce）。
- WS hook 用 `Proxy`/`Reflect.construct` 提升保真：修正 `constructor`、补静态属性、要求 `new`、加「已注入」哨兵防重复包裹。
- 保存配置时校验 `target !== original`。
- 统一 `debug` 日志开关，非调试路径不打印目标域等信息。

---

## 7. 是否改变现有功能语义

| 方案 | 用户可见行为 | 配置语义 | 说明 |
|---|---|---|---|
| A reconcile | 不变（多域名场景由「只剩一个」变为「全部生效」，属修复非语义变更） | 不变 | 规则 ID 内部实现细节，用户不可见 |
| B WS 延迟代理 | 首屏 WS 由「可能漏改」变为「正确重定向」；含 WS 规则页面早期连接 `open` 可能晚 ≤250ms | 不变 | 仅影响确有 WS 规则的页面 |
| C 动态注册 | 无 WS 规则页面不再被注入（更安全）；有规则页面行为不变 | 不变 | — |
| D observer 恢复 | SW 重启后自动发现不再失效 | 不变 | — |
| E Cookie 收敛 | 顶层导航不再被覆盖 Cookie（更安全）；XHR/WS 注入不变 | 不变 | localhost 完全不变 |
| F 健壮性 | 更稳定、更贴近原生 WebSocket | 不变 | — |

**结论**：所有改造均为**修复与加固**，不改变用户配置语义；唯一可感知差异是含 WS 规则页面首屏连接的轻微延迟（换取正确性），且仅限这些页面。

---

## 8. 具体代码改造点

> 仅列改造点，**本阶段不落地**。

**`constants.js`**
- `RULE_IDS` 改为 ID 分配策略说明 / 起始基数；或保留并标注「reconcile 时顺序分配」。

**`modules/rules.js`**
- 重构为 `reconcileFromConfigs(allSites)`：构建全量规则、统一编号、`getDynamicRules` 精确 remove。
- `buildCookieRule`：`resourceTypes` 收敛为 `['xmlhttprequest','websocket']`；保留 localhost/真实域名分支。
- `esc()` 扩展为完整正则转义（防御性）。

**`background.js`**
- 新增 `reconcileRules()`（debounced）作为唯一规则编排入口；`restoreAllRules`、`storage.onChanged`、`removeSite` 路径、`cookies.onChanged` 全部汇入。
- `storage.onChanged`：改为 `Object.keys(changes).some(k => k.startsWith('config.')||k.startsWith('cookies.')||k==='managed_sites')` → 触发 debounce reconcile。
- Set-Cookie 监听：支持**目标集合**（覆盖所有启用 target）。
- 新增 `restoreObservers()`：启动时 `tabs.query` 重建 observer。
- 新增 `syncWsContentScripts(domains)`：`registerContentScripts`/`update`/`unregister`。
- 全部 async handler 包裹错误处理。

**`content_ws.js`**
- 加入有界延迟代理；`message` 校验 `e.source===window`+结构；`Proxy`/`Reflect.construct` 保真；防重复注入哨兵。

**`content_bridge.js`**
- 配合动态注册；推送规则附带「就绪」标志（供延迟代理判断窗口结束）。

**`manifest.json`**
- 移除静态 `content_scripts`；新增 `scripting` 权限。
- 评估收窄 `host_permissions`（可选，谨慎）。

**`popup.js` / `devtools.js`**
- 真实域名 target 风险提示；`target===original` 校验。

---

## 9. 测试用例设计

> 以扩展无构建步骤，采用**手动 + 半自动**用例。建议在 `md/` 配套一个可重复的回归清单。

### 9.1 WS 首屏（问题 1 / 方案 B）
- T1：清空 tab/会话，首次打开含 WS 规则的页面，页面在最早内联脚本中 `new WebSocket(original)` → 断言连接落到 target（DevTools Network/WS 面板）。
- T2：页面在 DOMContentLoaded 后才建连 → 断言重定向正常（回归）。
- T3：无 WS 规则页面 → 断言 `window.WebSocket === 原生`（未被劫持），且无延迟。
- T4：延迟代理在 250ms 内规则到达 → `open` 正常；缓存的 `send()` 正确回放、顺序不乱。

### 9.2 SW 重启（问题 2 / 方案 D）
- T5：打开受管理页面 → `chrome://serviceworker-internals` 或空闲后强制终止 SW → 不刷新页面，触发新 XHR → 断言 `observed_apis.<domain>` 仍在更新。
- T6：SW 重启后多启用域名的 DNR 规则与 Set-Cookie 监听全部恢复（断言 `getDynamicRules` 含所有域名规则）。

### 9.3 多 config / 多域名（问题 4 / E1 / E4）
- T7：一次性导入/批量保存多个站点 → 断言所有站点的 DNR 规则都存在。
- T8：同时启用 2 个域名（不同 target）→ 断言两者 redirect + Cookie 规则共存、互不覆盖。
- T9：两个目标都返回 `Set-Cookie` → 断言两者 Cookie 均被回写。
- T10：单站点 6 个 http pair → 断言全部生成规则（E3 回归）。

### 9.4 无规则页面 footprint（问题 3 / 方案 C）
- T11：普通网站（无配置）→ 断言无 content script 注入、`window.WebSocket` 原生、无 `storage.get`。

### 9.5 删除/禁用恢复（E1/E2）
- T12：启用 A、B 两站点，删除 A → 断言 A 规则/WS 注册清除，**B 规则仍在**。
- T13：禁用 A → 断言仅 A 的规则/监听移除，B 不受影响。
- T14：删除站点后该页面 WS hook 不再生效（反注册）。

### 9.6 Cookie 注入范围（问题 5 / 方案 E）
- T15：localhost target，XHR → 断言 Cookie 注入正常（回归）。
- T16：真实域名 target，顶层导航（main_frame）→ 断言**不再**覆盖该域 Cookie；XHR 仍注入。
- T17：UI 对真实域名 target 显示风险提示。

### 9.7 并发/串扰
- T18：两个 tab 分属两个受管理域名并发请求 → 断言各自规则正确、observed 不串。

### 9.8 健壮性/保真（E5/E7/E9/E11）
- T19：注入非法 regex/异常配置 → 断言不崩、降级、日志可定位。
- T20：页面伪造 `postMessage({__switch:'ws_rules',...})` → 断言被忽略（来源/结构校验）。
- T21：`new WebSocket()` 缺参/非法 URL → 断言与原生一致抛错；`instanceof`、`constructor`、静态常量符合原生。
- T22：保存 `target===original` → 断言被拒/提示。

---

## 10. 回归验证方案

- **核心回归清单**（每次改动后跑一遍）：T2、T5、T8、T11、T13、T15、T18。
- **基线对照**：在 `main`（1.0.7）记录 T1/T5/T7/T8/T9/T16 当前表现（用于证明确实修复）。
- **DNR 一致性断言**：提供一个 devtools 按钮/脚本，对比 `getDynamicRules()` 与「由当前配置推导的期望规则集」是否一致（storage↔DNR 漂移检测）。
- **保真断言**：MAIN world 控制台脚本核对 `WebSocket.name/length/prototype.constructor`、`new` 要求、`instanceof`。
- **无副作用断言**：T11 在多个真实站点（含一个 dApp/钱包页面）验证 `window.WebSocket` 未被改写。

---

## 11. 分阶段实施步骤

> 每阶段独立可验证、可单独回滚；建议每阶段一组 commit。

**阶段 0｜准备（本阶段，已完成）**
- 拉取最新 `main`、创建 `v2`、输出本方案文档并提交。

**阶段 1｜正确性根因（最高优先）**
- 方案 A：`reconcileRules()` 全量重建（解决 E1/问题 4/E3/E4 的规则部分）。
- 方案 D：`restoreObservers()`（解决问题 2）。
- 回归：T5–T10、T12、T13、T18。

**阶段 2｜WS 与注入范围**
- 方案 C：动态注册 content script（解决问题 3、E2 反注册、E10）。
- 方案 B：WS 首屏延迟代理 + 缩小注入（解决问题 1）。
- 回归：T1–T4、T11、T14。

**阶段 3｜Cookie 与健壮性**
- 方案 E：Cookie resourceTypes 收敛 + target 类型区分 + UI 提示（问题 5）。
- 方案 F：错误处理、debounce、postMessage 校验、WS hook 保真、自环校验、日志分级（E5–E12）。
- 回归：T15–T17、T19–T22。

**阶段 4｜整体回归与文档**
- 跑完整用例集；更新 `README.md`/`CLAUDE.md`（文件结构、WS 限制说明、真实域名 target 风险）。
- 提交 `v2`。

---

## 12. 风险与回滚方案

| 改造 | 主要风险 | 缓解 | 回滚 |
|---|---|---|---|
| A reconcile | 全量重建若有 bug 影响所有域名 | 充分 T7–T10 回归；DNR 一致性断言；保留旧 `apply` 至验证通过 | 还原 `modules/rules.js` + `background.js` 编排 |
| B WS 延迟代理 | 代理保真不足、`send` 回放顺序/超时边界 | 仅对 WS 规则域名启用；T4/T21；超时回退原生直连 | 退回静态 hook（接受首屏竞态）|
| C 动态注册 | 注册集合与配置不同步导致漏注/多注 | reconcile 内统一对齐；`persistAcrossSessions`；T11/T14 | 恢复 manifest 静态 `content_scripts` |
| D observer 恢复 | 启动 `tabs.query` 大量 tab 时开销 | 仅对 `isManaged` tab 绑定；幂等 | 移除 `restoreObservers` |
| E Cookie 收敛 | 误判某些站点依赖 main_frame 注入 | 文档说明；保留 localhost 行为；可配置开关（如确有需要）| 还原 `resourceTypes` |
| F 健壮性 | 行为差异极小 | 单点小改、逐项测试 | 逐项 revert |

**全局回滚**：`v2` 与 `main` 隔离；每阶段独立 commit，可 `git revert` 单阶段或整体放弃 `v2`。扩展无构建产物，回滚即代码回退 + 重新「加载已解压扩展」。

---

## 附：实施边界（本阶段）

- ✅ 已做：拉取最新 `main`、创建 `v2`、输出本方案文档、提交文档。
- ⛔ 未做（待方案确认后再实施）：修改任何插件核心逻辑、调整现有功能行为、无关重构、改变用户配置语义。

> 方案确认后，按「第 11 节」分阶段在 `v2` 实施并提交。
