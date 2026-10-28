---
name: user-side-deploy-verify
description: 部署自验全绿 ≠ 用户端生效的三道门：① 入口缓存头审计（首页与 fallback 必须 no-store；有 ETag 无 Cache-Control 即启发式缓存隐患）② 用户侧取证（access.log 按 UA 还原 document 链比对 bundle hash，旧 hash 不 404 时零报错）③ 冷环境复现（新 profile + 登录态 + 截图）。触发词：用户端没生效、复验全绿但用户还是旧版、缓存头、no-store、access.log UA。不用于：部署方自验（frontend-hash-deploy-verify）、浏览器打不开网页（edge-net-check）。
---

# 用户端生效验证

## 核心判据

**自环境全绿不是证据。** 用户浏览器可能仍在跑旧入口（启发式缓存），而旧 bundle 文件通常不会 404，所以页面**零报错**、只是行为像旧版。

## 第一道门：入口缓存头

```bash
curl -sI https://<域名>/ | grep -iE "cache-control|etag|last-modified|expires"
curl -sI https://<域名>/<任意前端路由> | grep -iE "cache-control|etag|last-modified|expires"
```

- `index.html` 与 history fallback 必须 `Cache-Control: no-store`（至少 no-cache）。
- **只有 ETag / Last-Modified、没有 Cache-Control** ＝ 浏览器可启发式缓存 ⇒ 必须修。
- 带 hash 的静态资源可以长缓存，不受影响。
- 接入方自己的入口页同样要查，别只查网关/主站。

nginx 修法（示意）：

```nginx
location = /index.html { add_header Cache-Control "no-store" always; }
location @spa          { add_header Cache-Control "no-store" always; }
```

## 第二道门：用户侧取证

1. 按 User-Agent 在 `access.log` 里还原用户实际加载链：壳 → 登录/换票 → 资源 → 是否停在旧 bundle。
2. **主动比对 bundle hash**：把用户侧请求到的 `umi.*.js` / `main.*.js` 与本轮产物 hash 对照；旧 hash 仍能 200 就是关键证据。
3. 不要只看自环境 network；旧入口不报错，network 也是"全绿"。

## 第三道门：冷环境复现

用全新浏览器 profile（无缓存）+ 注入登录态（`addInitScript` 写 sessionStorage/localStorage token）跑完整链路，确认新代码能出界面并截图。视口不可用时用 playwright 而非截图工具。

## 存量缓存尾巴

服务端改 `no-store` **只对之后的响应生效**；已缓存旧入口的用户需要：

- 一次 Ctrl+F5（或强制刷新），或
- 同源 `fetch(url, {cache:'reload'})` 触发重新验证。

部署报告必须显式写这一条，否则用户会继续看到旧版并认为没修。

## 复发取证顺序（用户说"还是不行"时）

1. `curl -sI` 复核头部是否真的生效（可能改在错误 location）。
2. `access.log` 按 UA 取用户链，看是否仍请求旧 hash。
3. 冷 profile 复现：能出新版 ⇒ 用户端缓存；不能 ⇒ 服务端还有问题。
4. 再修 nginx / 让用户强制刷新，并把证据贴进汇报。

## 常见坑

| 现象 | 原因 |
|---|---|
| 自验全绿、用户旧版 | 入口启发式缓存 |
| 页面零报错但行为旧 | 旧 hash 文件仍可访问，不触发 404 |
| 改了头用户仍旧 | 只影响新响应；需一次强制刷新 |
| 改头无效 | 改到了错误的 location / 被上游覆盖 |
| 复现不了 | 用了带缓存的 profile；要全新 profile |

## 相关

- 部署方自验与 hash：`frontend-hash-deploy-verify`、`dual-track-server-deploy-verify`
- 浏览器完全打不开：`edge-net-check`
