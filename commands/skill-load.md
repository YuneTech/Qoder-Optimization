---
name: skill-load
description: 按关键词检索技能索引并给出 SKILL.md 路径（分层路由的按需加载入口）
---

# /skill-load —— 按需检索技能

```bash
node ~/.qoder/scripts/skill-load.cjs "$ARGUMENTS"
```

- 有命中：只读扫描两层实际文件，多关键词全部匹配，按分数列出前 6 个 → **Read 命中的 SKILL.md 再动手**。
- 无本地命中：输出 `NO_MATCH`（退出码 3），再用同一匹配逻辑查已登记的分享包。包候选标明本地文件存在/未发现，插件与 MCP 标未核验；检索不会安装、写索引或改登记位置。
- 无相关候选：换同义词再查一次；仍无才说明缺口并按现有工具处理。
- 退出码 2：实际目录读取失败或两层同名；核对真源，不覆盖或自动选择副本。
- `CATALOG_UNAVAILABLE`：包指针失效或索引损坏；明确报告缺口，确认包位置后使用 `/pkg-find` 的登记流程，不自动换包。

分层原则：`~/.qoder/skills/` 是常驻元技能，`~/.qoder/skills-library/` 是按需技能；增删移后显式运行 `node ~/.qoder/scripts/build-skills-index.cjs` 供其他工具使用。生成索引是快照，不替代实际文件。
