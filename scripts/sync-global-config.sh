#!/bin/bash
# 全局配置同步：AGENTS.md 与 rules/*.md 在 Qoder（~/.qoder）与 Qoder CN（~/.qoder-cn）
# 两侧各存实体副本（这两处不能做 junction：应用会校验路径必须在配置目录内），
# 因此靠本脚本保持内容一致。skills / scripts 等目录走 junction，本脚本不处理。
#
# 性能硬约束（2026-09-19 重写）：本脚本被 global-config-guard.js 在 SessionStart hook 里以 8s 超时调用，
# 而 Windows Git Bash 每次 spawn 子进程实测 ~130~800ms（随系统负载浮动）——旧版逐文件 cmp + ls|sed|sort
# 流水线（~15 次 spawn）闲时 2.5~4.5s、负载高时实测 12.3s ⇒ 会顶穿 8s 预算（周检据此报过 WARN）。
# 现版：通配符列清单（零 spawn）+ **一次 md5sum 覆盖两侧全部文件**（1 次 spawn），比对全在 bash 内。
# **改这里请保持"极少 spawn"**；预算表见 rules-weekly-audit.js 的 PERF_BUDGETS。
#
# 输出协议（调用方按行解析，勿改措辞）：--check 输出 DRIFT / ONLY-A / ONLY-B 行、退出码 1=有漂移；
# 同步模式输出 SYNCED / COPIED / DONE 行。global-config-guard.js 与 rules-weekly-audit.js 都取 /^(DRIFT|MISSING)/。
#
# 用法：
#   sync-global-config.sh [--check] 只检查；退出码 1 表示存在差异
#   sync-global-config.sh --from-qoder|--from-qoder-cn 经批准后按指定真源同步，覆盖前备份
set -uo pipefail
shopt -s nullglob

A="$HOME/.qoder"        # 非 CN
B="$HOME/.qoder-cn"     # CN
MODE="${1:---check}"
case "$MODE" in --check|--from-qoder|--from-qoder-cn) ;; *) printf '%s\n' '用法：sync-global-config.sh [--check|--from-qoder|--from-qoder-cn]；写入必须已获授权并指定真源。' >&2; exit 2 ;; esac
NODE="${QODER_NODE:-node}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_TOOL="$SCRIPT_DIR/backup-file.js"

changed=0; compared=0; drift=0; cp_fail=0

fail() { echo "ERROR: $*" >&2; exit 2; }
if [ ! -d "$A" ] && [ ! -d "$B" ]; then fail "两侧配置目录都不存在：$A / $B"; fi
# 单端模式（任一方向都算）：只装了一个客户端时"另一侧"本就不存在，没有可比对象 ⇒ 报一句退 0。
# 这是合法安装形态、不是错误——早先这里 fail 退 2，单端用户会在每次开台体检里收到"规则不生效"的假警报。
# 注意措辞：调用方按行取 /^(DRIFT|MISSING)/，这行不能以上述词开头；单端下**绝不 mkdir 另一侧**。
if [ ! -d "$A" ] || [ ! -d "$B" ]; then
  only="$A"; [ -d "$A" ] || only="$B"
  echo "[config-sync] 单端模式：只发现 $only（另一侧不存在），跳过比对；单端下无需同步。"
  exit 0
fi

# ── 哈希表：两侧现有文件（AGENTS.md + rules/*.md）一次 md5sum 全取（1 spawn）──
# 相对路径作键（AGENTS.md / rules/xxx.md），后续比对与补拷全在 bash 内进行
files_all=()
if [ -f "$A/AGENTS.md" ]; then files_all+=("$A/AGENTS.md"); fi
if [ -f "$B/AGENTS.md" ]; then files_all+=("$B/AGENTS.md"); fi
for p in "$A"/rules/*.md; do files_all+=("$p"); done
for p in "$B"/rules/*.md; do files_all+=("$p"); done
for p in "$A"/commands/*.md; do files_all+=("$p"); done
for p in "$B"/commands/*.md; do files_all+=("$p"); done

declare -A hashA=() hashB=()
if [ ${#files_all[@]} -gt 0 ]; then
  while read -r h f; do
    f="${f#\*}"                                # md5sum 二进制模式输出 "hash *path"
    case "$f" in
      "$A"/*) hashA["${f#"$A"/}"]="$h" ;;
      "$B"/*) hashB["${f#"$B"/}"]="$h" ;;
    esac
  done < <(md5sum -- "${files_all[@]}" </dev/null)
fi

# ── 清单：两侧相对路径并集（通配符，零 spawn；顺序 = A 侧在前，B 侧独有在后）──
rels=(); declare -A listed=()
if [ -f "$A/AGENTS.md" ] || [ -f "$B/AGENTS.md" ]; then
  rels+=("AGENTS.md"); listed[AGENTS.md]=1
fi
for p in "$A"/rules/*.md "$B"/rules/*.md; do
  rel="rules/${p##*/}"
  if [ -z "${listed[$rel]:-}" ]; then rels+=("$rel"); listed[$rel]=1; fi
done
# commands/*.md 同样是两侧各自的实体目录（客户端要求落在配置目录内）：
# 只挂一侧的指令会让另一侧静默没有这个 /命令，所以一并纳入漂移检查。
for p in "$A"/commands/*.md "$B"/commands/*.md; do
  rel="commands/${p##*/}"
  if [ -z "${listed[$rel]:-}" ]; then rels+=("$rel"); listed[$rel]=1; fi
done

for rel in "${rels[@]}"; do
  has_a=0; has_b=0
  if [ -f "$A/$rel" ]; then has_a=1; fi
  if [ -f "$B/$rel" ]; then has_b=1; fi

  if [ "$has_a" -eq 1 ] && [ "$has_b" -eq 1 ]; then
    compared=$((compared + 1))
    ha="${hashA[$rel]:-}"; hb="${hashB[$rel]:-}"
    # md5sum 取不到（缺命令 / 不可读）时哈希为空 ⇒ 按"不一致"处理，宁可报红不许假绿
    if [ -n "$ha" ] && [ "$ha" = "$hb" ]; then continue; fi
    drift=$((drift + 1))
    if [ "$MODE" = "--check" ]; then echo "DRIFT    $rel"; continue; fi
    if [ "$MODE" = "--from-qoder" ]; then src="$A/$rel"; dst="$B/$rel"; dir=".qoder -> .qoder-cn"
    else src="$B/$rel"; dst="$A/$rel"; dir=".qoder-cn -> .qoder"; fi
    if [ ! -f "$BACKUP_TOOL" ] || ! "$NODE" "$BACKUP_TOOL" "$dst"; then echo "BACKUP-FAIL $rel -> $dst" >&2; cp_fail=$((cp_fail + 1)); continue; fi
    mkdir -p "$(dirname "$dst")"
    if cp "$src" "$dst"; then echo "SYNCED   $rel  ($dir)"; changed=$((changed + 1))
    else echo "COPY-FAIL $rel -> $dst"; cp_fail=$((cp_fail + 1)); fi
    continue
  fi

  # 单侧存在：补齐另一侧
  drift=$((drift + 1))
  if [ "$MODE" = "--check" ]; then
    if [ "$has_a" -eq 1 ]; then echo "ONLY-A   $rel  (仅 .qoder 有)"
    else                        echo "ONLY-B   $rel  (仅 .qoder-cn 有)"; fi
    continue
  fi
  if [ "$MODE" = "--from-qoder" ] && [ "$has_a" -eq 1 ]; then src="$A/$rel"; dst="$B/$rel"; dir=".qoder -> .qoder-cn"
  elif [ "$MODE" = "--from-qoder-cn" ] && [ "$has_b" -eq 1 ]; then src="$B/$rel"; dst="$A/$rel"; dir=".qoder-cn -> .qoder"
  else echo "SOURCE-MISSING $rel（保留另一侧文件，不删除）"; cp_fail=$((cp_fail + 1)); continue; fi
  # 单侧存在时另一侧的 rules/ 或 commands/ 目录可能整个不存在 ⇒ 先建目录，再验 cp 真的成功
  mkdir -p "$(dirname "$dst")"
  if cp "$src" "$dst"; then echo "COPIED   $rel  ($dir)"; changed=$((changed + 1))
  else echo "COPY-FAIL $rel -> $dst"; cp_fail=$((cp_fail + 1)); fi
done

if [ "$MODE" = "--check" ]; then
  if [ "$drift" -eq 0 ]; then
    echo "IN-SYNC ($compared 个文件逐字节一致)"
    exit 0
  fi
  echo "DRIFT: $drift 个文件不一致（先比较差异；获准后用 --from-qoder 或 --from-qoder-cn 指定真源同步）" >&2
  exit 1
fi

if [ "$changed" -eq 0 ]; then
  echo "IN-SYNC ($compared 个文件逐字节一致，无需修改)"
else
  echo "DONE: 同步 $changed 个文件（比对 $compared 个）"
fi

# 调用方（rules-weekly-audit.js / global-config-guard.js）按退出码判"是否真修好了"，
# 复制失败必须让退出码非 0，否则周检会报出"已自动同步"的假绿。
if [ "$cp_fail" -gt 0 ]; then
  echo "SYNC-FAIL: $cp_fail 个文件复制失败" >&2
  exit 1
fi
