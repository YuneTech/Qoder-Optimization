# 归档考古方法论

扫描 `~/.qoder/chat-sessions/*.jsonl`，判定缺失文件是「从未落盘」还是「写了但丢了」。

## 核心逻辑

```javascript
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const targetFile = '<缺失文件的完整路径>';
const sessionsDir = path.join(process.env.HOME, '.qoder/chat-sessions');
const sessions = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));

let hitCount = 0;

(async () => {
  for (const session of sessions) {
    const sessionPath = path.join(sessionsDir, session);
    const rl = readline.createInterface({
      input: fs.createReadStream(sessionPath),
      crlfDelay: Infinity
    });
    
    for await (const line of rl) {
      try {
        const obj = JSON.parse(line);
        if (obj.role === 'assistant' && obj.tools) {
          for (const tool of obj.tools) {
            if (tool.name === 'Write' && tool.input?.file_path === targetFile) {
              hitCount++;
            }
          }
        }
      } catch (e) {
        // 跳过非 JSON 行
      }
    }
  }
  
  if (hitCount === 0) {
    console.log('从未落盘');
    process.exit(0);
  } else {
    console.log('写了但丢了，命中 ' + hitCount + ' 次');
    process.exit(1);
  }
})();
```

## 判定标准

- **hitCount = 0**：从未落盘。SKILL.md 是规划性写成，文件从未存在。修复路径：按真值重建或功能让渡。
- **hitCount ≥ 1**：写了但丢了。文件曾经存在但被删除或移动。修复路径：优先从归档恢复，否则重建。

## 性能注意

- 12MB 归档约 30 秒（readline 逐行解析）
- 大归档（>50MB）建议分批扫描，或先用 `grep -l '<文件路径>' *.jsonl` 定位会话再深入

## 实例：contract-requirement-testcase-authoring

来源会话 `28bd1706-6c5e-4943-8160-3702598316ca`，归档文件 `D:\qoder-data\qoder\projects\D--project\a5bb2b82-e6e3-4411-ba1b-a4ff5cfece48.jsonl`（12MB）。

扫描结果：9 个缺失文件的 Write 命中数 = 0 → 判定「从未落盘」。

修复决策：功能已被三个后继技能覆盖 → 交付引用映射表，不重建第四套资产。

## 工具失败替代

如果 `readline` 逐行解析太慢，改用 `grep` 快速定位：

```bash
grep -l '<缺失文件路径>' ~/.qoder/chat-sessions/*.jsonl
```

输出命中的会话文件列表，再针对性解析。
