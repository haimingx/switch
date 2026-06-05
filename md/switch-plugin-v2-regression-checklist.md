# SWITCH v2 回归验证清单

> 配合 `switch-plugin-v2-stability-plan.md`。扩展无构建步骤，验证方式为「`chrome://extensions` 加载已解压扩展 + DevTools 观察」。
> 每次改动后至少跑 **核心回归**（标 ★）。

## 加载与准备

1. `chrome://extensions/` → 开发者模式 → 「加载已解压的扩展程序」选择本目录（或重新加载）。
2. 打开扩展 Service Worker 的 DevTools（`检查视图: service worker`）观察 `[bg]` / `[rules]` 日志。
3. 准备：一个受管理前端域名 + 一个 localhost 目标（HTTP），可选 WS 目标。

---

## 用例

### A. WS 首屏（问题 1 / E9）
- [ ] **T1** 新标签页首次打开含 WS 规则的页面，页面早期 `new WebSocket(original)` → Network/WS 面板确认落到 target。
- [ ] **T2 ★** 已缓存会话内刷新页面 → WS 重定向正常（回归）。
- [ ] **T3** 无 WS 规则的普通页面控制台执行 `WebSocket === window.WebSocket` 且 `WebSocket.name==='WebSocket'`；确认未被劫持（见 T11）。
- [ ] **T4** 含 WS 规则页面，规则 250ms 内到达 → `onopen` 正常；`new WebSocket(...); ws.send(x)` 在 CONNECTING 时与原生一致抛 `InvalidStateError`。
- [ ] **T21** `new WebSocket()` 缺参/非法 URL 与原生一致抛错；`x instanceof WebSocket` 为 true；`WebSocket.CONNECTING/OPEN/CLOSING/CLOSED === 0/1/2/3`。

### B. SW 重启（问题 2）
- [ ] **T5 ★** 打开受管理页面，`chrome://serviceworker-internals` 或等待空闲终止 SW；**不刷新**页面，触发新 XHR/WS → `observed_apis.<domain>` 仍更新（自动发现恢复）。
- [ ] **T6** SW 重启后 `chrome.declarativeNetRequest.getDynamicRules()` 含所有启用域名的规则；Set-Cookie 监听对所有目标生效。

### C. 多 config / 多域名（问题 4 / E1 / E4 / E3）
- [ ] **T7** 一次性批量保存/导入多个站点配置 → 所有站点规则都存在。
- [ ] **T8 ★** 同时启用 2 个域名（不同 target）→ 两者 redirect + cookie 规则共存、互不覆盖。
- [ ] **T9** 两个目标都返回 `Set-Cookie` → 两域名 `cookies.<domain>` 均被更新。
- [ ] **T10** 单站点配置 6 个 HTTP pair → 全部生成 redirect 规则（不再因 >4 丢弃）。

### D. 注入范围 / footprint（问题 3）
- [ ] **T11 ★** 普通网站（未配置/无 WS 规则）→ 不注入 content script；控制台 `window.__switchWsHooked` 为 `undefined`，`window.WebSocket` 为原生。

### E. 删除 / 禁用恢复（E1 / E2）
- [ ] **T12** 启用 A、B；删除 A → A 规则/WS 注册清除，**B 规则仍在**。
- [ ] **T13 ★** 禁用 A → 仅 A 的规则/监听移除，B 不受影响。
- [ ] **T14** 删除含 WS 规则的站点 → `chrome.scripting.getRegisteredContentScripts()` 不再含该域名 matches；新开该页面 WebSocket 不再被劫持。

### F. Cookie 注入范围（问题 5）
- [ ] **T15 ★** localhost target，XHR → Cookie 注入正常（DevTools 请求头含注入的 Cookie）。
- [ ] **T16** 真实域名 target：顶层导航（main_frame）请求头 **不被** 覆盖 Cookie；XHR 仍注入。
- [ ] **T17** popup 对真实域名 target 显示「will be overwritten」警告；localhost target 无警告。

### G. 并发 / 健壮性（E5 / E7 / E11）
- [ ] **T18 ★** 两个 tab 分属两个受管理域名并发请求 → 各自规则正确、observed 不串。
- [ ] **T19** 故意配置异常（如超长/含元字符域名）→ SW 不崩溃，`reconcile failed` 安全降级（保留上一组规则），日志可定位。
- [ ] **T20** 在普通页面执行 `postMessage({__switch:'ws_rules', rules:[{original:'a',target:'b'}]}, '*')` → 被忽略（hook 未生效，因为该页面本就未注入；在注入页面伪造则因 `e.source===window` 校验仍接收——注意此为同源自身行为，符合预期）。
- [ ] **T22** popup 中将某 pair 的 From 与 To 设为相同 → 标红、不保存（自环防护）。

---

## 与 v1 基线对照（证明修复）

在 `main`(1.0.7) 记录以下表现，再在 `v2` 复测对比：

| 用例 | v1 预期（缺陷） | v2 预期（修复） |
|---|---|---|
| T8 多域名共存 | 只剩最后启用域名规则 | 两域名规则共存 |
| T5 SW 重启自动发现 | 需刷新才恢复 | 无需刷新自动恢复 |
| T10 >4 pair | 第 5 个起被丢弃 | 全部生效 |
| T9 多目标 Set-Cookie | 仅最后目标被回写 | 各目标均回写 |
| T11 无规则页面 | `window.WebSocket` 被劫持 | 原生未被触碰 |
| T16 真实域名 main_frame | Cookie 被覆盖 | 不再覆盖 |

---

## 一致性自检（可选脚本）

SW DevTools 控制台：

```js
// DNR 规则与启用配置是否一致
const rules = await chrome.declarativeNetRequest.getDynamicRules();
const all = await chrome.storage.local.get(null);
console.table(rules.map(r => ({ id:r.id, type:r.action.type, cond:r.condition.regexFilter||r.condition.urlFilter })));
console.log('managed:', all.managed_sites);
```
