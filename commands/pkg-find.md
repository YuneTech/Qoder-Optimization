---
name: pkg-find
description: 从分享包索引按关键词检索尚未安装的技能 / 脚本 / 命令 / 插件 / MCP，并按需加装
---

# /pkg-find —— 从分享包索引加装

```bash
node ~/.qoder/scripts/pkg-catalog.cjs search "$ARGUMENTS"
```

首次使用先登记分享包位置：`node ~/.qoder/scripts/pkg-catalog.cjs register <分享包目录>`。

- 命中后看状态：`shipped` 随包可直接装；`external` 只给官方安装方式；`template` 给合并说明；`disabled` 本机已停用、按需恢复
- 安装：`node ~/.qoder/scripts/pkg-catalog.cjs install <id>` 先预演，确认后加 `--apply`
- 技能默认进 `~/.qoder/skills-library/`（不注入）；要常驻加 `--tier core`，安装后会自动重建索引
- 插件 / 社区技能 / MCP 不代装、不转发源码，只按输出的官方方式执行
- `skill-load` 查不到时会自动到已登记的包内索引里找并给出加装命令
