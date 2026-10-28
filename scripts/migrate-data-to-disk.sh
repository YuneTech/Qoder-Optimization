#!/bin/bash
# ============================================================
# Qoder 数据目录迁移：把占空间大的数据目录从 C 盘迁到其他盘，
# 原路径用 junction 保持可用（软件无感，不用改任何配置）。
#
# 迁移对象（存在才处理；只迁"占空间大"的）：
#   ~/.qoder/logs        ~/.qoder/projects
#   ~/.qoder-cn/logs     ~/.qoder-cn/projects
# 明确不迁：skills / scripts / memory / rules / commands
#   （占空间小；skills 的读取兼容性未经证实，不经用户明确要求不冒险。）
#
# 用法：
#   bash migrate-data-to-disk.sh --to D              # 计划（dry-run，只列不迁）
#   bash migrate-data-to-disk.sh --to D --apply      # 执行迁移
#   bash migrate-data-to-disk.sh                       # 查看现状（是否已是链接）
#   bash migrate-data-to-disk.sh --cleanup            # 迁移确认无误后，删 *.bak-migrating
#
# 前置条件（脚本自己检查，不满足直接拒跑）：
#   ① 目标盘存在且有足够空间；
#   ② **所有 Qoder / Qoder CN 窗口已关闭** —— 客户端运行中时，进程句柄
#      仍指向旧目录，改名后新写入会走旧句柄 ⇒ 数据分叉（最坏的一种"假成功"）。
#
# 安全流程（每个目录）：复制 → 逐文件核字节 → 原目录改名保留
#   → 建 junction → 读文件验证。任何一步不过就停下并给回滚命令。
# 回滚（单目录）：
#   cmd /c rmdir "<C:\...\logs>"                  # 只删链接，不穿透目标
#   mv "<C:\...\logs.bak-migrating>" "<C:\...\logs>"
# ============================================================
set -u
export MSYS_NO_PATHCONV=1   # 不让 Git Bash 改写 /E /J 这类单字母参数

# ---------- 硬防呆①：只许用户手动执行（Agent / 自动化一律拒绝） ----------
# 依据 2026-09-23 实例：Qoder 运行中把 ~/.qoder/projects 改名，正在跑的会话写会话数据
# 文件时路径失效（ENOENT）→ 无法继续 → worker 崩溃退出（exit 1）。这类"必须停机才能做"
# 的操作只能由用户本人手动执行，Agent 不得代劳（用户明确要求，勿删本检查）。
if [ ! -t 0 ]; then
  printf '%s\n' '[拒绝执行] 本脚本只能由用户在自己的终端里手动运行。'
  printf '%s\n' '  检测到非交互环境（stdin 不是终端）：多为 Agent / 脚本 / 管道代跑。'
  printf '%s\n' '  原因：本脚本搬迁 Qoder 运行时数据目录；Qoder 未完全退出时执行会造成会话数据分叉或损坏。'
  printf '%s\n' '  正确做法：① 完全退出所有 Qoder / Qoder CN 窗口；② 用户亲自在本机终端执行本脚本。'
  exit 3
fi

DRIVE=""
APPLY=0
CLEANUP=0
for a in "$@"; do
  case "$a" in
    --to) ;;                       # 值在下一轮取
    --to=*) DRIVE="$(echo "${a#--to=}" | tr -d ':')" ;;
    --apply) APPLY=1 ;;
    --cleanup) CLEANUP=1 ;;
    [A-Za-z]) DRIVE="$(echo "$a" | tr 'A-Z' 'a-z')" ;;
    *) echo "未知参数: $a"; exit 2 ;;
  esac
done
# --to 后跟单独参数（如 "--to D"）
prev=""
for a in "$@"; do
  if [ "$prev" = "--to" ] && [ -z "$DRIVE" ]; then DRIVE="$(echo "$a" | tr -d ':' | tr 'A-Z' 'a-z')"; fi
  prev="$a"
done

ROBOCOPY="/c/Windows/System32/robocopy.exe"

# ---------- 工具 ----------
say()  { printf '%s\n' "$*"; }
fail() { printf '\n[停止] %s\n' "$*" >&2; exit 2; }

winpath() {  # 把 Git Bash 形式的路径换成 Windows 形式（<系统盘>\Users\<用户>\...）
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$p"; else
    local d="${p:1:1}"; printf '%s:%s\n' "$(echo "$d" | tr 'a-z' 'A-Z')" "${p:2}" | tr '/' '\\'
  fi
}

is_junction() {  # 返回 0 = 该路径已是 junction（Git Bash 的 -L 认 junction）
  [ -L "$1" ]
}

dir_bytes() { du -sb "$1" 2>/dev/null | cut -f1; }
dir_files() { find "$1" -type f 2>/dev/null | wc -l; }

# ---------- 现状盘点 ----------
mig_list() {
  for name in qoder qoder-cn; do
    for d in logs projects; do
      echo "qoder|$name|$d"
    done
  done
}

show_status() {
  say "=== 现状（迁移对象）==="
  local any=0
  while IFS='|' read -r _ name d; do
    local src="$HOME/.$name/$d"
    [ -d "$src" ] || [ -e "$src" ] || continue
    local sz; sz=$(dir_bytes "$src")
    local tag="实体目录"
    is_junction "$src" && tag="已是 junction"
    say "  ~/.$name/$d   $(awk "BEGIN{printf \"%.1f\", $sz/1048576}")MB   [$tag]"
    any=1
  done < <(mig_list)
  [ "$any" = 1 ] || say "  （没有任何迁移对象，无需处理）"
}

# ---------- 迁移主流程 ----------
do_migrate() {
  local drv="$DRIVE"
  [ -n "$drv" ] || fail "缺少目标盘：用法 migrate-data-to-disk.sh --to D [--apply]"
  local mnt="/$drv"
  [ -d "$mnt" ] || fail "目标盘不存在：$drv:（在 Git Bash 里应能看到 $mnt）"
  [ -x "$ROBOCOPY" ] || fail "找不到 robocopy：$ROBOCOPY"

  # 逐目录迁移（dry-run 只列计划，不查进程）
  local plan=""
  while IFS='|' read -r _ name d; do
    local src="$HOME/.$name/$d"
    [ -e "$src" ] || continue
    local dst="$mnt/qoder-data/$name/$d"
    plan="$plan$name/$d\n"
  done < <(mig_list)
  [ -n "$plan" ] || { say "没有可迁移的目录。"; return 0; }

  say "=== 迁移计划（目标盘 $drv:）==="
  printf "  %b" "$plan"
  if [ "$APPLY" != 1 ]; then
    say ""
    say "以上为 dry-run。确认无误后加 --apply 执行（执行前需完全关闭所有 Qoder 窗口）。"
    return 0
  fi

  # 客户端必须全关（只有真要动数据时才检查）
  # 2026-09-23 修：本脚本顶部已导出 MSYS_NO_PATHCONV=1，`tasklist //NH` 会被原样传入 →
  # 报"无效参数"，而 `2>/dev/null | grep` 把错误吞成"没有进程" ⇒ 守卫恒放行（假绿）。
  # 实例：守卫失效当天，logs 在客户端运行中完成改名，旧目录仍被写入 9 分钟（数据分叉）。
  # 现在：显式判 tasklist 退出码，取不到进程列表就中止（fail-closed）；用单斜杠参数配合无路径转换。
  local plist plist_rc
  plist="$(tasklist /FO CSV /NH 2>/dev/null)"; plist_rc=$?
  if [ "$plist_rc" != 0 ] || [ -z "$plist" ]; then
    fail "无法枚举进程（tasklist 退出码 $plist_rc）——不能在无法确认客户端已关闭时迁移，已中止。"
  fi
  local procs
  procs="$(printf '%s\n' "$plist" | cut -d',' -f1 | tr -d '"' | grep -iE '^qoder' | sort -u || true)"
  if [ -n "$procs" ]; then
    fail "检测到仍在运行的客户端进程：$(echo "$procs" | tr '\n' ' ')
请先**完全退出所有 Qoder / Qoder CN 窗口**（含托盘图标）再重跑。
原因：运行中的客户端句柄仍指向旧目录，改名会造成写入分叉（假成功）。"
  fi

  local failed=0
  while IFS='|' read -r _ name d; do
    local src="$HOME/.$name/$d"
    local dst="$mnt/qoder-data/$name/$d"
    [ -e "$src" ] || continue
    say ""
    say "────── 迁移 ~/.$name/$d ──────"
    if is_junction "$src"; then say "  已是 junction，跳过"; continue; fi
    if [ -e "$src.bak-migrating" ]; then
      if is_junction "$src"; then
        say "  [跳过] 已存在 $src.bak-migrating（上次迁移的备份）——确认运行平稳几天后再跑 --cleanup 清理"
      else
        say "  [跳过] $src.bak-migrating 存在、且 $src 不是 junction：这是【未完成的迁移】留下的数据本体，"
        say "         不是可清理的备份（--cleanup 会拒绝删它）。请在 Qoder 全关时先把内容合并回 $src："
        say "         robocopy \"$(winpath "$src.bak-migrating")\" \"$(winpath "$src")\" /E /MOVE /XJ"
      fi
      failed=1; continue
    fi

    # 复制
    mkdir -p "$dst"
    say "  复制中…"
    "$ROBOCOPY" "$(winpath "$src")" "$(winpath "$dst")" /E /COPY:DAT /XJ /R:1 /W:1 /NP /NFL /NDL >/tmp/robocopy.out 2>&1
    local rc=$?
    if [ "$rc" -ge 8 ]; then say "  [失败] robocopy 退出码 $rc"; tail -5 /tmp/robocopy.out; failed=1; continue; fi

    # 核对：文件数 + 字节数
    local sf df sb db
    sf=$(dir_files "$src"); df=$(dir_files "$dst")
    sb=$(dir_bytes "$src"); db=$(dir_bytes "$dst")
    if [ "$sf" != "$df" ] || [ "$sb" != "$db" ]; then
      say "  [失败] 核对不一致：源 $sf 文件/$sb B vs 目标 $df 文件/$db B（目标已保留，源未动，可重跑）"
      failed=1; continue
    fi
    say "  核对通过：$sf 个文件，$sb 字节"

    # 改名 + 建链
    mv "$src" "$src.bak-migrating" || { say "  [失败] 原目录改名失败（仍被占用？）"; failed=1; continue; }
    # env -u 临时移除 MSYS_NO_PATHCONV：该变量开着时 `//c` 不会被转成 `/c`，cmd 会进交互模式又
    # 立刻退出（rc=0 **假成功**），链接根本没建——2026-09-23 实踩：显示"junction 已建"但全没建。
    if out=$(env -u MSYS_NO_PATHCONV cmd //c mklink //J "$(winpath "$src")" "$(winpath "$dst")" 2>&1); then
      say "  junction 已建：$out"
    else
      say "  [失败] mklink 失败：$out —— 回滚改名"
      mv "$src.bak-migrating" "$src" ; failed=1; continue
    fi

    # 验证：能从原路径读到文件。用 ls 而非 find —— MSYS 的 find 不穿透 junction
    # （链接完全正常也返回空 = 假失败）；ls / cat 可穿透（2026-09-23 实测）。
    local probe; probe="$(ls -A "$src" 2>/dev/null | head -1)"
    if [ -n "$probe" ] && [ -r "$src/$probe" ]; then
      say "  验证通过：经原路径可读 → $probe"
    else
      say "  [警告] 经原路径读不到文件，请人工检查；回滚命令：cmd /c rmdir \"$(winpath "$src")\" && mv \"$src.bak-migrating\" \"$src\""
      failed=1
    fi
  done < <(mig_list)

  say ""
  if [ "$failed" = 0 ]; then
    say "=== 全部完成 ==="
    say "下一步：① 打开 Qoder 确认历史会话 / 日志正常；② 稳定运行几天后跑"
    say "     bash ~/.qoder/scripts/migrate-data-to-disk.sh --cleanup   # 删 *.bak-migrating 备份"
  else
    say "=== 部分目录未完成（上方有 [失败]）==="
    say "源目录都是完好的（要么未动，要么改名保留为 *.bak-migrating），可修因后重跑。"
    exit 1
  fi
}

do_cleanup() {
  local n=0 skipped=0
  while IFS='|' read -r _ name d; do
    local bak="$HOME/.$name/$d.bak-migrating"
    local src="$HOME/.$name/$d"
    if [ -d "$bak" ]; then
      # 硬守卫：只有 src 已是 junction（迁移真正完成）时，bak 才只是"备份"。
      # src 不是 junction ⇒ 迁移没做完，bak 是数据本体，删了 = 丢数据（2026-09-23 实例差点踩）。
      if ! is_junction "$src"; then
        say "  [拒绝清理] $bak —— $src 不是 junction：这是【未完成迁移的数据本体】，不是备份，删掉会丢数据。"
        say "             正确做法：先把 $bak 的内容合并回 $src，再重跑迁移。"
        skipped=$((skipped+1)); continue
      fi
      local sz; sz=$(dir_bytes "$bak")
      say "删除备份 $bak （$(echo "scale=1; $sz/1048576" | bc 2>/dev/null)MB）"
      rm -rf "$bak" && n=$((n+1))
    fi
  done < <(mig_list)
  say "清理完成：删除 $n 个备份目录（安全跳过 $skipped 个未完成迁移的目录）。"
  [ "$skipped" = 0 ] || exit 1
}

# ---------- 入口 ----------
# 硬防呆②：危险动作（--apply / --cleanup）必须人工当面确认——即便上面的非交互检查
# 被某种方式绕过，也过不了"人亲口输入 yes"这一关。
if [ "$APPLY" = 1 ] || [ "$CLEANUP" = 1 ]; then
  printf '%s\n' '本操作会搬动 / 删除 Qoder 运行时数据目录，前提是【已完全退出所有 Qoder / Qoder CN 窗口】。'
  printf '请人工确认（输入 yes 继续）：'
  read -r _ans
  if [ "$_ans" != "yes" ]; then printf '%s\n' '已取消（未输入 yes）。'; exit 3; fi
fi

if [ "$CLEANUP" = 1 ]; then do_cleanup; exit 0; fi
if [ -n "$DRIVE" ]; then do_migrate; else show_status; fi
