---
name: memory-entry-update
description: 更新单条已有长期记忆的可复现流程：Read 正文与 MEMORY.md 两个载体 → 各跑 backup-file.js → Edit 三处成对改动（正文 / frontmatter description / 索引行）→ 四条能失败的验收（含周检 0 告警，[INFO] 不算告警）→ 区分已验证与未验证。触发词：更新记忆、记忆索引同步、改 MEMORY.md、记忆维护。不用于：新建记忆（self-evolution）、链接与凭据审计。
---

# 记忆条目更新

## 为什么要成对改

一条记忆有三个载体，漏一个就会漂移：

1. 记忆正文（`memory/<name>.md`）
2. 正文的 frontmatter `description`（检索与索引用）
3. `MEMORY.md` 的索引行（**不带 frontmatter**，必须单独同步）

## 步骤

1. **Read 两个文件**：正文 + `MEMORY.md`，确认条目已存在、当前措辞与链接。
2. **备份两个载体**（改哪个备哪个）：
   ```bash
   node ~/.qoder/scripts/backup-file.js "<memory 文件>"
   node ~/.qoder/scripts/backup-file.js "<MEMORY.md>"
   ```
   不要用 `cp` 手搓，备份会无裁剪地堆积。
3. **Edit 三处成对改动**：
   - 正文：按锚点插入/替换，保留其他会话内容；
   - frontmatter：`description` 单行，反映新增内容；
   - 索引：`- [标题](file.md) — 一句话钩子`，不超过约 150 字符。
4. **四条可失败验收**：
   - `grep` 正文关键词命中；
   - `grep` 索引关键词命中；
   - Glob 确认没有新增平行条目（注意：Glob 会把本轮 `.bak` 一起带出来，属正常）；
   - `node ~/.qoder/scripts/rules-weekly-audit.js --no-fix` 退出码 0，且结论是「健康（0 告警）」。
     **输出的 `[INFO]` 行（临时产物 / 门禁台账 / 磁盘水位 / hook 健康）不是告警**，据此判黄属误报。
5. **汇报**：写清改了哪三处、验收命令与结果；提示词层无法程序化验证的部分显式标「未验证 + 原因」。

## 边界

- 只更新经核验的长期事实；短期进度、排错配方、代码结构不进记忆。
- 用户明确要求"记住/忘记"时才新增或删除；普通重试与临时纠正不强制写入。
- 两侧客户端记忆目录若是同一真源（junction），只改一次；不是则改完跑同步脚本并 `--check`。
- 删除条目时同步删索引行，避免悬空引用。

## 相关

- 记忆链接 / 凭据审计：`memory-link-and-credential-audit`
- 规则周检：`global-config-smoke-runner`
