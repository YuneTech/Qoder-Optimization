# 推荐插件清单（按需装，不必全装）

插件来源是 Qoder 官方市场 / 随客户端捆绑，**本包不转发其源码**；按名字在市场里搜装即可。
本机实况与建议（"本机禁用"的都是踩过坑或与自研机制重复的）：

| 插件 | 建议 | 用途 / 理由 |
|---|---|---|
| `design-review@qoder-marketplace` | 推荐 | 前端设计质量：无障碍 / 响应式 / 设计债 / DESIGN.md 审查 / 视觉回归 等 10 个子技能 |
| `open-code-review@qoder-marketplace` | 推荐 | 代码评审：`ocr` CLI 驱动的行级评审意见 |
| `postman@qoder-marketplace` | 推荐 | API 工作流：集合 / 环境 / mock / 规格 与 200+ 工具 |
| `qoder-cloud-agents@qoder-marketplace` | 推荐 | 云端 Agent：会话、模板、定时任务与执行结果 |
| `computer-use@qoder-bundler` | 可选 | 桌面 GUI 自动化（点击 / 输入 / 截图）；不用可关 |
| `Presentations@qoder-marketplace` | 可选 | PPTX 读写与生成（有演示需求的装） |
| `qoder-context@qoderapp-bundler` | 随客户端 | 上下文增强，随 Qoder 提供 |
| `qoder-create-plugin@qoder-bundler` | 可选 | 要自己写插件时装，否则可关 |
| `gitlab@qoder-marketplace` | 本机禁用 | 内网 GitLab 无 MCP 端点（探测 /api/v4/mcp 404，需 GitLab 18.3+），装了也用不起来 |
| `security-scan@qoder-bundler` | 按需 | 安全扫描；不进日常路径时关掉省一份工具面 |
| `cloud-agents@qoder-marketplace` | 本机禁用 | 旧名插件，已被 qoder-cloud-agents 取代（同名同能力两份会互相抢） |
| `better-harness@qoder-bundler` | 本机禁用 | 与本机自研规则强制层（hooks + 门禁脚本）职责重复 |

## 在 settings.json 里怎么写

```json
{
  "enabledPlugins": {
    "design-review@qoder-marketplace": true,
    "open-code-review@qoder-marketplace": true,
    "postman@qoder-marketplace": true,
    "qoder-cloud-agents@qoder-marketplace": true,
    "computer-use@qoder-bundler": true,
    "gitlab@qoder-marketplace": false,
    "security-scan@qoder-bundler": false,
    "cloud-agents@qoder-marketplace": false,
    "better-harness@qoder-bundler": false
  }
}
```

改完**重开客户端**才全部生效（插件与 MCP 都在启动时读取）。

## 与 MCP 的分工

- 插件 = 能力包（技能 / 子智能体 / 命令 / 可附带的 MCP 声明）；
- MCP = 具体连接（数据库 / 文档 / 浏览器 / 桌面驱动），配置见 `mcp/mcpServers.example.json` 与 `mcp/README-mcp.md`。
- 两者都遵循同一条纪律：**先查已装的，同域不装第二个**；装之前扫一遍是否夹带越权指令（要求外发数据 / 改配置 / 读凭据 / 跳过确认）。
