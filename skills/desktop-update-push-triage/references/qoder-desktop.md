# Qoder 桌面端实例（国际版 / CN）

> 这是通用流水线的产品实例。换到其他客户端时按 SKILL.md 第 8 节重新定位入口，不要照搬这里的路径。

## 入口对照

| 用途 | 国际版 | CN 版 |
|---|---|---|
| 数据目录 | `%APPDATA%\com.qoder.app.stable` | `%APPDATA%\com.qodercn.app.stable` |
| 状态文件 | `<数据目录>\updates\v1\state.json` | 同构 |
| 日志 | `<数据目录>\logs\<yyyyMMdd-HHmmss.fff-pid-hash>\main.log` | 同构 |
| 安装目录 | `D:\Program Files\Qoder\Qoder` | `D:\Program Files\Qoder\Qoder CN` |
| 更新缓存 | `%LOCALAPPDATA%\qoder-updater` | `%LOCALAPPDATA%\qoder-cn-updater` |

日志标签：`[DesktopUpdate]`（状态机）、`[DesktopUpdateScheduler]`（后台轮询）、`[DesktopUpdateInstaller]`（下载/安装进度，成功后有 `download progress`）。

## state.json 关键字段（本机 2026-10-23 实测）

```json
{
  "stage": "idle",
  "installType": "system",
  "pinnedAssignment": { "decision": "hold", "reason": "server-no-update", "retryAfterSeconds": 14400 },
  "lastError": null
}
```

- `stage`：`idle → checking → available → downloading → installing`。
- `pinnedAssignment.decision = "hold"` ⇒ **服务端暂缓下发，不是故障**。本机 0.4.9 两客户端同为此状态，后台检查实测约 30 分钟一轮（以日志时间戳为准）。
- `lastError` 是权威错误原文，日志只有 reason 码。
- `updatedAt` 可判断状态文件是否还在被写入（客户端是否还在跑）。

## 安装目录 resources 四件套（本机实测）

- `app-update.yml`：`provider: generic`，`url: https://download.qoder.com.cn/qoder-app/releases`，`updaterCacheDirName: qoder-updater`
- `install-type.json`：`{"installType":"system"}`
- `product.json`：`dataDirectoryName`、`desktopUpdateDownloadBaseUrl`
- `build-manifest.json`：`productVersion` / `installerType` / `buildTime`

Assignment 接口（从 `main.log` 的 `Desktop update assignment request started` 取真实 URL）：
`https://center.qoder.sh/algo/api/update/desktop/win32-x64/stable/<当前版本>`，返回 `assignmentId`。

## 0.4.8 起：更新缓存目录禁止符号链接（红线）

`%LOCALAPPDATA%\qoder-updater`（CN 为 `qoder-cn-updater`）是 junction / 符号链接时，自动更新每次都在 `downloading` 阶段**几百毫秒内失败**（本机实测 228ms），`pending` 一个字节都不写。

- `lastError` 原文：「更新缓存目录不能是符号链接。」
- **提权启动、改装 User 版都无效**——这是路径形态校验，不是权限问题。
- 修复：`cmd /c rmdir "<缓存目录>"`（只摘链接，禁 `rm -rf`）→ `mkdir` 同名真实目录。
- 交叉判据：往新目录写标记文件，不得出现在旧真源里（旧真源本机在 `E:\MigratedFromC\*-updater`，原地保留当回滚）。
- 复验负对照：对 `com.qoder.app.stable` 做链接查询，确认未误碰。

## 下载通了之后卡安装（CN 实测）

GUI 安装器报「检测到多个与 Qoder CN 安装位置相关的旧安装记录」/「无法安全完成此次 System 更新…**不要改用 User 安装包**」时：

```powershell
powershell -NoProfile -Command "Start-Process -FilePath '<已校验的 system 包路径>' -ArgumentList '/S' -Wait -PassThru"
```

- 只用 `/S`，**别加 `/D=`**（含空格会破坏 NSIS 解析）。
- **别用 Node spawn / execFile**：CreateProcess 不带提权，对 system 包一律 `EACCES`，换目录照样 EACCES。
- **别动 `.qoder-installer-recovery-*`**：实测不是「多个旧安装记录」的原因，改名全 EPERM，静默重装照样成功。
- 收口：`build-manifest.json` 的 `productVersion` + exe FileVersion + HKLM `DisplayName`（如 `Qoder 0.4.9`）三处一致；下次启动 `state.json` 会从 `installing` 复位为 `idle`。

## 两条容易误判的链路

- `%LOCALAPPDATA%\Qoder\Qoder Launcher\system-nsis-update.ini` 的 `systemNsisResult=installed` 属于**启动器事务安装**，与后台 `[DesktopUpdate]` 自动更新是两条路；`pending` 里有旧包也不代表自动更新成功过。
- 手动 `navigate` 打开 `latest*.yml` 得到的 `ERR_FAILED` 是假信号（触发下载而非导航）。

## 已排除项（本机实测）

管理员启动、改装 User 版、磁盘空间、缓存目录写权限、文件句柄占用、hosts / 代理 / TLS、CDN 多解析 IP、`.qoder-installer-recovery-*`、明文 grep `app.asar`（0.4.8+ 已混淆/编译进快照，三种手段零命中）。

## 现状（2026-10-23）

两客户端均为 0.4.9，`qoder-updater` / `qoder-cn-updater` 已是 C 盘真实目录，`stage=idle`、`lastError=null`、`pinnedAssignment=hold`（服务端暂缓）。`%APPDATA%\com.qoder.app.stable` 与 `com.qodercn.app.stable` 是到 `D:\qoder-data\...` 的 junction（允许；只禁止更新缓存成链接）。
