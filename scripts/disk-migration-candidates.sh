#!/bin/bash
# ============================================================
# 只读：扫描 C 盘上"可清 / 可迁"的用户目录与 AppData 大头，按档位出清单。
# 用途：触发 C 盘清理（/clean-disk）或首次应用分享包时，把结果列进 AskUserQuestion，
#      让用户点名要处置哪些；**本脚本不删、不搬、不改任何配置**，可以放心跑。
# 依赖：bash（Git Bash）+ du。用法：bash disk-migration-candidates.sh [--top N]
#
# 档位（处置手段不同，安全等级也不同）：
#   DELETE  崩溃 / 堆转储产物，软件已退出且不会再引用 —— 直接删最省事（零风险）
#   TRIM    缓存类 —— 删内容即可释放；目录本身留给软件重建（只删内容，不删目录）
#   JUNCTION 我方 / 工具的数据目录 —— 走 migrate-data-to-disk.sh 安全搬（须先停占用进程）
#   OFFICIAL 软件自带"改存储路径"开关 —— **优先用官方开关**，别拿 junction 代替（注册表可能记着旧路径）
#   SYSTEM  Windows 已知文件夹 —— 走「属性 → 位置 → 移动」向导，别手搓 junction
#   NEVER   明确不迁（系统 / 企业管控持有其路径；junction 可能被卸载器穿透删真源）
# ============================================================
set -u
export MSYS_NO_PATHCONV=1

TOP=999
while [ $# -gt 0 ]; do
  case "$1" in
    --top) shift; TOP="${1:-999}" ;;
    --top=*) TOP="${1#--top=}" ;;
    *) echo "未知参数: $1"; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }

# 类别|标签|路径|动作建议
ROWS='DELETE|JVM 崩溃转储|$HOME/hs_err_pid*.mdmp|直接删（进程已死，纯诊断产物）'
ROWS="$ROWS
DELETE|IDEA 堆转储|$HOME/java_error_in_idea*.hprof|直接删（内存溢出时的现场快照，看完即可丢）"
ROWS="$ROWS
DELETE|JVM 重放日志|$HOME/replay_pid*.log|直接删（C2 编译重放日志）"
ROWS="$ROWS
TRIM|系统临时目录|$LOCALAPPDATA/Temp|只删超限内容、不删目录本身（软件假定它存在）"
ROWS="$ROWS
TRIM|npm 缓存|$LOCALAPPDATA/npm-cache|npm cache clean --force；或改路径见下'OFFICIAL'"
ROWS="$ROWS
TRIM|Playwright 浏览器|$LOCALAPPDATA/ms-playwright|不跑 E2E 可删，用时自动重下；或设 PLAYWRIGHT_BROWSERS_PATH"
ROWS="$ROWS
TRIM|通用工具缓存|$HOME/.cache|按子目录挑（多数是下载缓存，删了会重下）"
ROWS="$ROWS
TRIM|pip 缓存|$LOCALAPPDATA/pip/Cache|pip cache purge"
ROWS="$ROWS
JUNCTION|Qoder 数据（本机）|$HOME/.qoder|会话记录 + 日志 + 技能，走迁移脚本（**须先完全退出所有 Qoder 窗口**）"
ROWS="$ROWS
JUNCTION|Qoder 数据（CN 版）|$HOME/.qoder-cn|同上"
ROWS="$ROWS
OFFICIAL|Android SDK / 模拟器|$HOME/.android|官方开关：ANDROID_SDK_ROOT / ANDROID_AVD_HOME 指到 D 盘（模拟器镜像最适合搬）"
ROWS="$ROWS
OFFICIAL|Maven 本地库|$USERPROFILE/.m2|settings.xml 改 localRepository=D:\\m2-repo"
ROWS="$ROWS
OFFICIAL|Gradle 缓存|$USERPROFILE/.gradle|环境变量 GRADLE_USER_HOME=D:\\gradle-home"
ROWS="$ROWS
OFFICIAL|uv 缓存|$LOCALAPPDATA/uv|环境变量 UV_CACHE_DIR=D:\\uv-cache"
ROWS="$ROWS
OFFICIAL|JetBrains 系统/日志|$LOCALAPPDATA/JetBrains|idea.properties 的 idea.system.path / idea.log.path"
ROWS="$ROWS
OFFICIAL|Chrome / Edge 用户数据|$LOCALAPPDATA/Google|启动参数 --user-data-dir（profile 有活动锁，别用 junction）"
ROWS="$ROWS
SYSTEM|下载|$USERPROFILE/Downloads|「属性 → 位置 → 移动」向导"
ROWS="$ROWS
SYSTEM|文档|$USERPROFILE/Documents|同上"
ROWS="$ROWS
SYSTEM|桌面|$USERPROFILE/Desktop|同上"
ROWS="$ROWS
NEVER|UWP / Store 应用数据|$LOCALAPPDATA/Packages|系统持有路径，junction 会出问题"
ROWS="$ROWS
NEVER|LocalAppData\\Microsoft|$LOCALAPPDATA/Microsoft|含系统组件缓存与应用状态，被服务直接寻址"
ROWS="$ROWS
NEVER|Roaming AppData 根|$APPDATA|注册表登记路径，牵连一批软件"
ROWS="$ROWS
NEVER|Program Files|$PROGRAMFILES|要换位置只能重装时指定目录"

say "=== C 盘清理 / 迁移候选（只读扫描，不改任何东西）==="
say ""

kb_of() {  # 路径可能含通配，累加匹配到的每个目标
  local pat="$1" total=0 f sz
  for f in $pat; do
    [ -e "$f" ] || continue
    if [ -d "$f" ]; then sz=$(du -sk "$f" 2>/dev/null | cut -f1); else sz=$(( $(stat -c %s "$f" 2>/dev/null || echo 0) / 1024 )); fi
    [ -n "$sz" ] && total=$(( total + sz ))
  done
  printf '%s' "$total"
}

TMPF="$(mktemp)"
trap 'rm -f "$TMPF"' EXIT
while IFS='|' read -r tier label path action; do
  [ -n "$tier" ] || continue
  real="$(eval echo "$path" 2>/dev/null)"
  matched=0
  for r in $real; do [ -e "$r" ] && { matched=1; break; }; done
  [ "$matched" = 1 ] || continue
  if [ "$tier" = "NEVER" ]; then
    say "  [NEVER]     $label"
    say "              $real  ← 不迁不删，列出来只为说明'为什么不动它'"
    continue
  fi
  kb=$(kb_of "$path")
  [ "$kb" -gt 0 ] || continue
  # 必须落文件：$(printf ...) 的命令替换会剥掉行尾换行，拼进变量就把多条压成一行
  printf '%s\t%s\t%s\t%s\t%s\n' "$kb" "$tier" "$label" "$path" "$action" >> "$TMPF"
done <<< "$ROWS"

[ -s "$TMPF" ] || { say "  （未发现可处置项）"; exit 0; }

sort -rn "$TMPF" | head -n "$TOP" | while IFS=$'\t' read -r kb tier label path action; do
  [ -n "$kb" ] || continue
  say "  $(awk "BEGIN{printf \"%7.2f GB\", $kb/1048576}")  [$tier] $label"
  say "              路径：$path"
  say "              动作：$action"
done

awk -F'\t' '{s[$2]+=$1; t+=$1} END {
  printf "\n=== 合计 ===\n"
  printf "  可释放（DELETE+TRIM）：%.2f GB\n", (s["DELETE"]+s["TRIM"])/1048576
  printf "  可搬迁（JUNCTION+OFFICIAL）：%.2f GB\n", (s["JUNCTION"]+s["OFFICIAL"])/1048576
  printf "  全部候选：%.2f GB\n", t/1048576
  printf "  注：NEVER 档不计入，只作说明展示。\n"
}' "$TMPF"

if [ "$(awk -F'\t' '$2=="JUNCTION"||$2=="OFFICIAL"{s+=$1} END{print s+0}' "$TMPF")" -gt 1048576 ]; then
  say ""
  say "下一步（AI 侧）：把 DELETE/TRIM 与 JUNCTION/OFFICIAL 分两组列进 AskUserQuestion，"
  say "  推荐项＝DELETE 全清 + JUNCTION 迁 Qoder 数据（需停机）+ OFFICIAL 里真正在用的包缓存；"
  say "  两组都拿到答复才动手。清理走 /clean-disk（disk-sweeper.js），搬迁走 migrate-data-to-disk.sh。"
fi
