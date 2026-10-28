#!/usr/bin/env bash
# sync-global-config.sh 的回归自测（2026-09-19 重写时建立；夹具全在临时目录，HOME 覆盖指向夹具，不动真实配置）
# 用法：bash ~/.qoder/scripts/sync-global-config.test.sh   （全绿退出 0，有 FAIL 退出 1）
# 覆盖：全一致 / 内容漂移（--check 报 DRIFT；指定真源后同步并备份，复检 IN-SYNC）/ 默认只读不覆盖 /
#       单边缺失（ONLY-* → COPIED）/ 量具缺失必报红（缺 md5sum 时按不一致处理，不许假绿）/ 真实目录冒烟
set -uo pipefail
S="${SUT:-$HOME/.qoder/scripts/sync-global-config.sh}"
T="$(mktemp -d)"; pass=0; fail=0
ok()  { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; echo "      $2"; fail=$((fail + 1)); }

mk() { # $1=根：两侧 AGENTS.md + rules/{one,two}.md，全一致
  local R="$1"
  rm -rf "$R"; mkdir -p "$R/home/.qoder/rules" "$R/home/.qoder-cn/rules"
  printf 'A1\n' > "$R/home/.qoder/AGENTS.md"
  cp "$R/home/.qoder/AGENTS.md" "$R/home/.qoder-cn/AGENTS.md"
  printf 'r1\n' > "$R/home/.qoder/rules/one.md"
  printf 'r2\n' > "$R/home/.qoder/rules/two.md"
  cp "$R/home/.qoder/rules/"*.md "$R/home/.qoder-cn/rules/"
}

echo "== T1 全一致：--check 应 IN-SYNC / exit 0"
mk "$T/t1"; out=$(HOME="$T/t1/home" bash "$S" --check); rc=$?
if [ "$rc" = 0 ] && [[ "$out" == *"IN-SYNC (3 个文件逐字节一致)"* ]]; then ok "T1 一致"; else bad "T1 一致" "rc=$rc out=$out"; fi

echo "== T2 内容漂移：--check 报 DRIFT；默认只读不覆盖；指定真源后同步并备份；复检一致"
mk "$T/t2"; printf 'Anew\n' > "$T/t2/home/.qoder/AGENTS.md"; touch "$T/t2/home/.qoder/AGENTS.md"
out=$(HOME="$T/t2/home" bash "$S" --check); rc=$?
if [ "$rc" = 1 ] && [[ "$out" == *"DRIFT    AGENTS.md"* ]]; then ok "T2a --check 报 DRIFT"; else bad "T2a 报 DRIFT" "rc=$rc out=$out"; fi
out=$(HOME="$T/t2/home" bash "$S"); rc=$?
if [ "$rc" = 1 ] && cmp -s <(printf 'A1\n') "$T/t2/home/.qoder-cn/AGENTS.md"; then ok "T2b 默认只读不覆盖另一侧"; else bad "T2b 默认只读" "rc=$rc out=$out"; fi
out=$(HOME="$T/t2/home" bash "$S" --from-qoder); rc=$?
if [ "$rc" = 0 ] && [[ "$out" == *"SYNCED   AGENTS.md  (.qoder -> .qoder-cn)"* ]] && cmp -s "$T/t2/home/.qoder/AGENTS.md" "$T/t2/home/.qoder-cn/AGENTS.md" && ls "$T/t2/home/.qoder-cn/"AGENTS.md.bak* >/dev/null 2>&1; then ok "T2c 指定真源同步并备份"; else bad "T2c 同步" "rc=$rc out=$out"; fi
out=$(HOME="$T/t2/home" bash "$S" --check); rc=$?
if [ "$rc" = 0 ] && [[ "$out" == *"IN-SYNC"* ]]; then ok "T2d 复检一致"; else bad "T2d 复检" "rc=$rc out=$out"; fi

echo "== T3 单边缺失：--check 报 ONLY-A；同步 COPIED 补齐"
mk "$T/t3"; rm "$T/t3/home/.qoder-cn/rules/two.md"
out=$(HOME="$T/t3/home" bash "$S" --check); rc=$?
if [ "$rc" = 1 ] && [[ "$out" == *"ONLY-A   rules/two.md  (仅 .qoder 有)"* ]]; then ok "T3a --check 报 ONLY-A"; else bad "T3a 报 ONLY-A" "rc=$rc out=$out"; fi
out=$(HOME="$T/t3/home" bash "$S" --from-qoder); rc=$?
if [ "$rc" = 0 ] && [[ "$out" == *"COPIED   rules/two.md  (.qoder -> .qoder-cn)"* ]] && cmp -s "$T/t3/home/.qoder/rules/two.md" "$T/t3/home/.qoder-cn/rules/two.md"; then ok "T3b COPIED 补齐"; else bad "T3b 补齐" "rc=$rc out=$out"; fi

echo "== T4 量具崩了不许假绿：缺 md5sum 时 --check 必须报 DRIFT / exit 1"
mk "$T/t4"; BASH_BIN="$(command -v bash)"
out=$(env -i PATH='' HOME="$T/t4/home" "$BASH_BIN" "$S" --check 2>&1); rc=$?
if [ "$rc" = 1 ] && [[ "$out" == *"DRIFT    AGENTS.md"* ]]; then ok "T4 无 md5sum 报红"; else bad "T4 无 md5sum 报红" "rc=$rc out=$out"; fi

echo "== T5 真实目录冒烟：--check 应 <5s 退出（0 或 1 都算正常，报告实况）"
s=$(date +%s%N); out=$(bash "$S" --check); rc=$?; e=$(date +%s%N); ms=$(( (e - s) / 1000000 ))
echo "      输出: $out   [${ms}ms]"
if [ "$rc" -le 1 ] && [ "$ms" -lt 5000 ]; then ok "T5 真实目录 ${ms}ms（rc=$rc）"; else bad "T5 真实目录" "rc=$rc ms=$ms"; fi

echo "== T6 commands/*.md 也在漂移范围内（只挂一侧的指令会让另一侧静默没有这个 /命令）"
mk "$T/t6"; mkdir -p "$T/t6/home/.qoder/commands" "$T/t6/home/.qoder-cn/commands"
printf 'cmd\n' > "$T/t6/home/.qoder/commands/clean-x.md"
out=$(HOME="$T/t6/home" bash "$S" --check); rc=$?
if [ "$rc" = 1 ] && [[ "$out" == *"ONLY-A   commands/clean-x.md  (仅 .qoder 有)"* ]]; then ok "T6a --check 报出只有一侧的指令"; else bad "T6a 指令漂移" "rc=$rc out=$out"; fi
out=$(HOME="$T/t6/home" bash "$S" --from-qoder); rc=$?
if [ "$rc" = 0 ] && [[ "$out" == *"COPIED   commands/clean-x.md  (.qoder -> .qoder-cn)"* ]] && cmp -s "$T/t6/home/.qoder/commands/clean-x.md" "$T/t6/home/.qoder-cn/commands/clean-x.md"; then ok "T6b 指令 COPIED 补齐"; else bad "T6b 指令补齐" "rc=$rc out=$out"; fi
printf 'cmd2\n' > "$T/t6/home/.qoder/commands/clean-x.md"; touch "$T/t6/home/.qoder/commands/clean-x.md"
out=$(HOME="$T/t6/home" bash "$S" --check); rc=$?
if [ "$rc" = 1 ] && [[ "$out" == *"DRIFT    commands/clean-x.md"* ]]; then ok "T6c 指令内容漂移也报 DRIFT"; else bad "T6c 指令 DRIFT" "rc=$rc out=$out"; fi

echo "== T7 单端（只装 Qoder，没有 ~/.qoder-cn）：合法形态，应 exit 0 且明说跳过"
rm -rf "$T/t7"; mkdir -p "$T/t7/home/.qoder/rules"
printf 'A1\n' > "$T/t7/home/.qoder/AGENTS.md"; printf 'r1\n' > "$T/t7/home/.qoder/rules/one.md"
out=$(HOME="$T/t7/home" bash "$S" --check 2>&1); rc=$?
if [ "$rc" = 0 ] && [[ "$out" == *"单端模式"* ]]; then ok "T7 单端"; else bad "T7 单端" "rc=$rc out=$out"; fi

echo "== T8 另一侧 rules/ 目录整个不存在（2026-10-06 实测故障态：旧版 cp 失败仍打 COPIED 且退 0 ⇒ 周检假绿「已自动同步」）"
rm -rf "$T/t8"; mkdir -p "$T/t8/home/.qoder/rules" "$T/t8/home/.qoder-cn"
printf 'A1\n' > "$T/t8/home/.qoder/AGENTS.md"; printf 'r1\n' > "$T/t8/home/.qoder/rules/one.md"
printf 'A2\n' > "$T/t8/home/.qoder-cn/AGENTS.md"
out=$(HOME="$T/t8/home" bash "$S" --from-qoder 2>&1); rc=$?
if [ "$rc" = 0 ] && cmp -s "$T/t8/home/.qoder/rules/one.md" "$T/t8/home/.qoder-cn/rules/one.md"; then
  ok "T8a 缺目录时补齐并真的落地文件"
else bad "T8a 缺目录补齐" "rc=$rc 落地=$([ -f "$T/t8/home/.qoder-cn/rules/one.md" ] && echo Y || echo N) out=$out"; fi
out=$(HOME="$T/t8/home" bash "$S" --check 2>&1); rc=$?
if [ "$rc" = 0 ] && [[ "$out" == *"IN-SYNC"* ]]; then ok "T8b 补齐后复检 IN-SYNC"; else bad "T8b 复检" "rc=$rc out=$out"; fi

echo "== T9 复制真失败（目标 rules 位置被普通文件占住）：必须出声且 exit 1"
rm -rf "$T/t9"; mkdir -p "$T/t9/home/.qoder/rules" "$T/t9/home/.qoder-cn"
printf 'A1\n' > "$T/t9/home/.qoder/AGENTS.md"; printf 'r1\n' > "$T/t9/home/.qoder/rules/one.md"
printf 'A2\n' > "$T/t9/home/.qoder-cn/AGENTS.md"; printf 'blocker\n' > "$T/t9/home/.qoder-cn/rules"
out=$(HOME="$T/t9/home" bash "$S" --from-qoder 2>&1); rc=$?
if [ "$rc" = 1 ] && [[ "$out" == *"COPY-FAIL"* ]] && [[ "$out" == *"SYNC-FAIL"* ]]; then
  ok "T9 复制失败报 COPY-FAIL/SYNC-FAIL 且退 1"
else bad "T9 复制失败出声" "rc=$rc out=$out"; fi

rm -rf "$T"
echo "───────────────"
echo "结果：PASS=$pass FAIL=$fail （临时夹具已清理）"
[ "$fail" -eq 0 ]
