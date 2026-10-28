# 分档处置手册（六档 × 条目 × 官方开关）

数据来源：`~/.qoder/scripts/disk-migration-candidates.sh` 的白名单与 2026-09-23 本机实测体积。
候选清单以脚本实时输出为准，本文件只解释**为什么这样归档**与**每个开关怎么写**。

## DELETE · 崩溃 / 堆转储产物（确认后直删）

进程已死、软件不会再引用，删除比搬迁省事，且体积常常最大。

| 条目 | 路径（用户目录根） | 本机实测 | 说明 |
| --- | --- | --- | --- |
| JVM 崩溃转储 | `hs_err_pid*.mdmp` | 单文件可达 6 GB | 崩溃时的现场快照 |
| IDEA 堆转储 | `java_error_in_idea*.hprof` | 约 3 GB | 内存溢出快照，看完即可丢 |
| JVM 重放日志 | `replay_pid*.log` | 约 8 MB | C2 编译重放日志 |

判据：确认对应进程（IDE / java）当前未运行，且不需要留作工单附件。

## TRIM · 缓存类（只删超限内容，不删目录本身）

软件假定目录存在，连根删掉 = 把「清理」做成「弄坏正在用的软件」。

| 条目 | 路径 | 首选官方命令 | 兜底 |
| --- | --- | --- | --- |
| npm 缓存 | `%LOCALAPPDATA%\npm-cache` | `npm cache clean --force` | 要搬位置见 OFFICIAL 的 `npm config set cache` |
| pip 缓存 | `%LOCALAPPDATA%\pip\Cache` | `pip cache purge` | — |
| Playwright 浏览器 | `%LOCALAPPDATA%\ms-playwright` | 不跑 E2E 可直接删（用时自动重下） | `PLAYWRIGHT_BROWSERS_PATH` 改位置 |
| 系统临时目录 | `%LOCALAPPDATA%\Temp` | 只删超限文件 | — |
| 通用工具缓存 | `~/.cache` | 按子目录挑 | 多数是下载缓存，删了会重下 |

## OFFICIAL · 有官方改路径开关（一律用开关，别拿 junction 代替）

理由：注册表 / 配置文件里可能记着旧路径，junction 看似正常，更新或重装时踩雷。

| 条目 | 现在的默认位置 | 官方开关写法 |
| --- | --- | --- |
| npm 缓存 | `%LOCALAPPDATA%\npm-cache` | `npm config set cache D:\npm-cache` |
| Gradle | `~\.gradle` | 环境变量 `GRADLE_USER_HOME=D:\gradle-home` |
| Maven 本地库 | `~\.m2\repository` | `settings.xml` 的 `<localRepository>D:\m2-repo</localRepository>` |
| uv 缓存 | `%LOCALAPPDATA%\uv` | 环境变量 `UV_CACHE_DIR=D:\uv-cache` |
| JetBrains 系统 / 日志 | `%LOCALAPPDATA%\JetBrains` | `idea.properties`：`idea.system.path` / `idea.log.path` |
| Chrome / Edge 用户数据 | `%LOCALAPPDATA%\Google` | 启动参数 `--user-data-dir`（profile 有活动锁，**别用 junction**） |
| Android SDK / 模拟器 | `~\.android`、`~\.gradle` | `ANDROID_SDK_ROOT` / `ANDROID_AVD_HOME` 指到 D 盘（模拟器镜像最适合搬） |
| Qoder 自身（部分） | — | 应用内改存储路径的设置项优先；没有才按 JUNCTION 档处理 |

**环境变量只对新进程生效**：设完要重启宿主软件 / 终端，且**删旧路径内容必须在重启之后**——旧进程还在往里写时删源就是丢数据。

## SYSTEM · Windows 已知文件夹

`Downloads` / `Documents` / `Desktop` 走「属性 → 位置 → 移动」向导。
不要手搓 junction：资源管理器与注册表按已知文件夹 GUID 寻址，向导会同步更新引用。

## JUNCTION · 自有 / 工具的数据目录

只有既无官方开关、又不是已知文件夹的数据才走 junction（原路径保持不变，软件无感）。

- Qoder 侧默认只搬每个客户端目录下的 `logs` / `projects`（可用 `--items "logs projects worktrees"` 扩条目）；`skills` / `scripts` / `memory` / `rules` / `commands` **不迁**——占空间小，且经链接读取的兼容性未证实，不冒险。
- **更新链路目录属 `NEVER` 级**：`%LOCALAPPDATA%\Qoder*`（启动器 `Qoder Launcher` 的 `state.system.ini` / `system-nsis-update.ini`，更新安装交接的中枢）与所有 `*-updater`。2026-09-24 实测：把它们做成 junction 后更新反复卡在 `[DesktopUpdate] interrupted-install-handoff`（安装包已下载且哈希一致，失败在执行 / 交接环节）。`%APPDATA%\Qoder*`（Roaming 侧）经用户实测判定可迁——工具按 `appdata-roaming|appdata-local` 标签区分，Local 侧会打印「不迁移（更新相关）」并跳过。
- 主入口（**由本人在真实终端跑**）：`~/.qoder/scripts/Qoder数据目录迁移.cmd`——纯批处理、免 Git / Python / Node，双击进菜单，`--status` / `--to D [--apply]` / `--merge-back` / `--revert logs|projects|all` / `--cleanup --apply` / `--wt-clean`；默认连 `%APPDATA%` / `%LOCALAPPDATA%` 下的 Qoder 目录一起处理（迁到 `<盘>:\qoder-data\appdata-roaming|local\<名>`），`--no-appdata` 只处理 `~/.qoder*`。
- 备选：`qoder-data-migrate.sh`（Git Bash 版，防呆只挡 `--apply`，只读盘点可由 Agent 跑）、`migrate-data-to-disk.sh`（旧版，无条件拒非交互）、`migrate-qoder-data.ps1 -To D [-Apply|-Undo]`。给同事 / 双击场景一律用 `.cmd`。
- 顺序不可反：复制 → 逐文件核字节 → 原目录改名 `*.bak-migrating` → `mklink /J` → 经原路径读文件验证。回退在没有 `*.bak-migrating` 时自动改走「从联接目标复原」（复制到 `<原路径>.restore` → 校文件数 → `rmdir` 断链 → 改名）。

## NEVER · 明确不碰（只作说明，不进弹窗选项）

| 条目 | 路径 | 为什么 |
| --- | --- | --- |
| UWP / Store 应用数据 | `%LOCALAPPDATA%\Packages` | 系统持有路径，junction 会出问题 |
| 系统组件缓存与应用状态 | `%LOCALAPPDATA%\Microsoft` | 被服务直接寻址 |
| Roaming AppData 根 | `%APPDATA%` | 注册表登记路径，牵连一批软件 |
| 已安装程序 | `Program Files` | 要换位置只能重装时指定目录 |

共性：这些目录由系统或卸载器 / 更新器直接寻址，junction 可能被**穿透删掉真实源**。

## 硬否决路径段（清理侧同样适用）

任一路径段命中就跳过，**即使被 `--root` / `--extra-root` 显式指到**：
`memory` / `rules` / `scripts` / `commands` / `credentials` / `.git` / `AGENTS.md` / `settings.json` / `qoder-*-cwd`（宿主为每个会话建的目录，实测数百个）。

## 实测坑清单（都有过代价）

| 坑 | 现象 | 正确做法 |
| --- | --- | --- |
| 运行中搬迁 | 会话数据文件 ENOENT → 会话无法继续、worker 崩溃退出 1（2026-09-23） | 先完全退出所有客户端窗口；脚本用 `tasklist` 检查，取不到进程列表就中止（fail-closed），不要为了跑通关掉它 |
| `rm -rf` 删链接 | 穿透 junction 删掉真实数据 | 只能 `cmd /c rmdir <链接>`，并带 `< /dev/null`（rmdir 删非空联接会弹确认，无输入会挂住） |
| `robocopy` 缺 `/XJ` | 穿透已有链接拷真源 | 一律 `/E /COPY:DAT /XJ /R:1 /W:1 /NP` |
| Git Bash 路径改写 | `/J` `/E` 被换成本地路径，`mklink` 报用法错 | 脚本顶部 `export MSYS_NO_PATHCONV=1`；建链 / 断链时用 `env -u MSYS_NO_PATHCONV cmd //c ...` |
| 全盘 `du` | 用户目录 / `AppData` 全量统计超时（实测后台跑不返） | 用候选脚本的白名单定向统计 |
| 命令替换剥换行 | 多行候选被压成一行、合计串成 `2.90554.2f GB` | 结果写临时文件（`mktemp` + `trap`），不要 `$(printf ...)` 收集多行 |
| `{ ...; fi` | bash 语法错 `syntax error near unexpected token 'fi'` | 改完先 `bash -n <脚本>` 再执行 |
| 未完成迁移的残留 | `*.bak-migrating` 存在且原路径不是链接 = 上次中断 | 先按脚本提示补做 / 回滚，**别直接 `--cleanup`**（会删掉数据本体） |
| 迁了更新链路目录 | 更新反复卡在 `[DesktopUpdate] interrupted-install-handoff`，版本不变、状态回退 ready（2026-09-24） | `%LOCALAPPDATA%\Qoder*` 与 `*-updater` 归 `NEVER`；已误迁的 `--revert <目录名> --apply` 回退 |
| `\??\` 前缀 | PowerShell 建的 junction 在 `dir /AL` 里目标显示 `\??\E:\...`，`if exist` / robocopy / move 不认 → 回退误报「联接目标不存在」 | 读目标后统一剥 `\??\` 与 `\\?\`（一处修，盘点 / 回退 / 清理全好） |
| MSYS `find` 不穿透链接 | 用 `find` 枚举联接内容得到空结果 → 判「没数据」的假阴性 | 校验可读性一律 `ls` / `cat` |
| 读验证只看顶层 | `projects` 顶层只有 slug 目录、无文件 → 迁移其实成功却报失败（2026-09-23 实测） | 探针**递归**找任意文件再经原路径读 |
| 复验漏 `/XJ` | 复制带 `/XJ`、复验不带 → 联接里的文件被算成「还缺」，报「目标缺源文件」假警报 | 复验与复制用同一开关组（`robocopy /L` 计划模式复验） |
| 守卫管道吞错 | `tasklist //NH` 报错被 `2>/dev/null \| grep` 吞成「没有进程」→ 进程守卫恒放行，客户端运行中照样搬迁（数据分叉 9 分钟） | 显式判 `tasklist` 退出码，取不到列表即中止（fail-closed）；参数用单斜杠配合无路径转换 |

## 迁移后复验判据（每条都要能失败）

1. 目标**确为 junction 且解析到同一真源**（不是「两侧目录都在」——合并成链接后「比对两侧一致」恒真，属假绿）。
2. `node ~/.qoder/scripts/rules-weekly-audit.js --no-fix` 零告警。
3. `bash ~/.qoder/scripts/sync-global-config.sh --check` 返回 `IN-SYNC`。
4. 新会话能正常启动、日志确实落到新位置；`OFFICIAL` 类改动要重启宿主后再验。
5. 清理侧：再跑一次不带 `--apply` 的扫描，核对「清理前 GB → 清理后 GB」与档位剩余计数，并把 `--restore "<归档目录>\manifest.json"` 抄进汇报。

## 实跑状态（区分清楚，别一概说成"没验证"）

- **已真实执行并验收**：`Qoder数据目录迁移.cmd` 的迁移 / 合并 / 回退 / 清理四条路径，2026-09-23 在停机窗口 + 隔离沙箱跑通；`~/.qoder{,-cn}/logs|projects` 与 AppData 的 `com.qoder.app.stable` 等目录确为 junction 且解析到 `D:\qoder-data\...`，源 vs 目标全量比对 `only-src=0`。
- **未实跑**：Bash 版 `migrate-data-to-disk.sh --apply` 全流程——它要求真实 tty，本机既无 `script` 也无 `winpty`，Agent 侧构造不出终端；已有证据只覆盖 dry-run 逻辑、参数解析、非交互拒绝（四组含 `--to z` 对照组）与回滚命令正确性。
- **未做真机键盘验收**：`.cmd` 菜单的 ↑/↓ 选择器交互路径（注入按键在本机不稳），只做过"stdin 喂输入 + CLI 等价 dry-run"的无键盘验收；首次给同事用前建议本人双击复看一遍。
- **已踩过的真实事故**（写进上面的坑清单）：运行中改名 `projects` 导致会话崩溃（09-23）、误迁 `Local\Qoder` 导致更新卡安装交接（09-24）。
