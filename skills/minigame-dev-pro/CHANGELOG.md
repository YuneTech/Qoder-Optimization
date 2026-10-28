# 小游戏开发专家 (minigame-dev-pro) 更新日志

> 版本号随每次升级递增，与 SKILL.md `version` / `metadata.version` / 脚本 / manifest 五处一致。
> 本文件为版本变更的唯一权威记录，与 SKILL.md「更新日志」同步维护。

## v1.1.0 (2026-09-04)

### SkillHub 框架合规与缺陷修正（同日追加）
- **提交被平台拒（version 非 semver）根因修复**：SKILL.md 含 UTF-8 BOM（﻿ 前置于首行 ---），严格前置解析器无法识别文档起始标记致字段解析错乱；同时 frontmatter 含规范外扩展字段（display_name/description_zh/description_en/visibility/agent_created）。已去除 BOM 并精简为官方规范字段集（name/description/version: 1.1.0/metadata.version: 1.1.0），经真实 YAML 解析验证 + 15 闸门复跑全绿。
- **框架合规**：SKILL.md frontmatter 补齐 SkillHub 必填字段 `agent_created: true`，并对齐已发布技能规范补 `display_name` / `display_name_en` / `description_zh` / `description_en` / `visibility: "public"`（`name`/`version` 原已存在，版本号不变）。
- **正文瘦身对齐官方 2.6**：按腾讯云「Skills 文件规范」（2026-07-20 版）"正文建议 ≤500 行"要求，SKILL.md 由 805 行瘦身为 449 行（body≈437）。细节不丢失：更新日志指向权威 CHANGELOG.md；首次加载/专家团/自进化细节由既有 onboarding.md / expert-panel.md / evolution-protocol.md 承载（SKILL.md 留指针）；文件引用索引压为紧凑清单且**全部文件名字符串保留**（闸门依赖）。同轮修复索引漏列（operations/ 三件、accessibility.md、asset-pipeline.md、engine-expert.md、build-matrix.json）与执行层协议内"27/32"旧计数残留（→31/36）、质量闸门节缺 3 个新闸门 bullet（12→15 列全）。
- **localize-check.mjs 修复**：敏感词预检原只扫目标语言字符串、漏扫源语言（中文词库对英文/日文目标几乎不命中，预检实际失效）→ 补扫源语言，现覆盖源语言及所有目标语言字符串。
- **asset-audit.mjs 修复**：命名正则 `/^[a-z0-9_]+/` 拒绝连字符，与其报错文案"建议小写+下划线/连字符"矛盾（`ui-icon.png` 被误报）→ 正则放行 `-`，文档与代码一致。
- 两处修复均经功能证真（源语言敏感词命中出现；`ui-icon.png` 命名 warn 消失、大写命名仍 warn）。

### 出海本地化闭环（新增）
- 新增 `scripts/localize-check.mjs`：i18n 资源完整性校验（缺键/空值/疑似未翻译（值与默认语言同值））+ 跨语言敏感词预检（复用 `sensitive-words.json` 七分类词库，覆盖源语言及目标语言字符串，命中即人工复核，不直接判定违规）。**P0 输入契约**：`--project` 必填，缺即 exit 1 不静默跑空。导出 `runLocalize` 供 i18n-gate 复用。0 外部依赖。
- 新增 `references/knowledge/operations/localization.md`：出海本地化方法论 + human-in-the-loop 边界表（翻译交专业服务、真机/母语审校交用户）。

### 资产生产工作流（新增）
- 新增 `scripts/asset-audit.mjs`：资产规格审计（命名/格式/尺寸 warn + 未授权 IP 命中硬违规 fail，交人工确权，禁止未授权商用）；纯审计不本地生图/生音频（与"本地 ComfyUI 生图作废"纪律一致）。导出 `runAssetAudit` 供 asset-gate 复用。0 外部依赖。
- 新增 `references/knowledge/art-audio/asset-pipeline.md`（新建 `art-audio/` 子目录，与既有 `art-audio.md` 通用指南并存）：资产规格 + 授权声明（asset-spec.json）+ 生成式资产边界 + 未授权 IP 红线。

### 发行运营复盘（新增）
- 新增 `scripts/release-gate.mjs`：校验 `production/release-checklist.md` 四节（上线前/热更/复盘/合规沟通）完整性，不替用户写复盘，绝不标"已通过官方审核"。导出 `runReleaseGate` 供 release-gate 闸门复用。0 外部依赖。
- 新增 `references/knowledge/operations/release-ops.md`：发行运营复盘方法论 + 与数据驱动运营/数值评审/本地化/资产联动。

### 本地轻量 CI 等价物（新增）
- 新增 `scripts/ci-local.mjs`：全量 .mjs 语法检查 + 跑确定性质量闸门（不含需联网的 link-audit），任一失败 exit 1，作本地 pre-commit/构建校验；支持 `--project` 额外跑项目级闸门（i18n-gate/asset-gate/release-gate 等）。0 外部依赖。

### 新增闸门（tests/，3 道）
- `tests/i18n-gate.mjs`：复用 `localize-check.mjs` 的 `runLocalize` 零重复；资源缺失=skip / 缺口=warn，绝不标 pass；真机/母语审校交用户/专业服务。
- `tests/asset-gate.mjs`：复用 `asset-audit.mjs` 的 `runAssetAudit` 零重复；未授权 IP 命中=硬失败（exit 1）交人工确权，warn 级=warn，资产目录缺失=skip，绝不标 pass。
- `tests/release-gate.mjs`：复用 `release-gate.mjs` 的 `runReleaseGate` 零重复；清单缺四节=warn，完整=skip，绝不标 pass；官方审核不在 agent 范围。
- 均支持自检模式验证子系统接线（知识文档存在 + 工具语法 + SKILL.md 引用）。

### 知识闭环补全
- 回填 `operations/analytics-ops.md` 路由条目（1.0.9 漏列）；补 `compliance/accessibility.md` 路由条目（1.0.9 漏列）。

### 文档联动
- SKILL.md：版本 1.0.9→1.1.0（frontmatter + metadata）；执行工具计数 27→31（scripts/ 31 + lib 5 = 36 个 .mjs）；工具速查/执行工具清单/质量闸门清单补 localize-check/asset-audit/ci-local/release-gate + i18n-gate/asset-gate/release-gate；知识路由补 operations(localization/release-ops/analytics-ops 回填)/art-audio(asset-pipeline)/compliance(accessibility 回填)；端到端链路补出海/发行闭环步。
- execution-protocol.md：执行工具清单补 4 工具；新增「流程8：出海与发行闭环」；知识层联动补 localization/asset-pipeline/release-ops；降级策略补 4 工具（纯文件/纯计算，不降级）。

### 验证矩阵
- localize-check 跑 zh+en/ja 校验（缺键/空值/未翻译/敏感词预检）+ --project 缺失 exit 1。
- asset-audit 跑命名/格式/尺寸 warn + 未授权 IP 硬违规 fail。
- release-gate 跑四节完整/skip/warn。
- ci-local 全量语法 + 确定性闸门。
- 新闸门自检模式全绿（含 SKILL.md 引用检查）；项目模式 skip/warn/fail 三态验证。
- 全 mjs 语法 OK；工具计数自校验 31==31；质量闸门 15==15；manifest SHA-256 自洽；0 外部依赖；0 残留；`.workbuddy` 不进包。

### 回退基线
- 保留 `小游戏开发专家1.0.9.zip` 作回退基线；若本版回归可回退至 1.0.9。

## v1.0.9 (2026-09-04)

### 数值平衡量化（新增）
- 新增 `scripts/balance-check.mjs`：蒙特卡洛模拟工具，覆盖三种模型——
  - `drop`：加权掉落率（观测 vs 期望 + 95% 置信区间 + EV）。
  - `economy`：货币 source/sink 建模，通胀/紧缩/稳定判定 + sinkCoverage（消耗/产出比趋近 1 为健康）。
  - `difficulty`：玩家爬塔留存模拟，定位难度断崖（最大单关流失 spikeLevel/spikeDrop）。
  - **P0 输入契约（计划附录②）**：必须提供 `--in <file.json>` 或 `--data '<json>'`，schema 按模型校验；无合法输入即 `outputError` 退出（exit 1），**绝不静默跑空、绝不伪造报告**。
  - 种子 PRNG（mulberry32）保证可复现；导出 `simulateDrop/Economy/Difficulty` 与 `runBalance` 供 balance-gate 复用，零重复逻辑；纯计算不自动改数值，供决策。
  - 0 外部依赖。

### QA 测试计划生成（新增）
- 新增 `scripts/qa-plan.mjs`：按项目画像（复用 `project-detector` 推断引擎 + `project-state` 取平台/变现）裁剪功能/性能/兼容/合规/回归五类，产出 `tests/qa-plan.md` 骨架；具体用例由人工/CI 填充，不伪称已覆盖。0 CLI 依赖。

### 经济系统量化与付费伦理（新增）
- 新增 `references/knowledge/game-design/economy-balance.md`（对齐真实目录 `game-design/`，非计划原文的 `design/`）：source/sink 建模方法 + 与 balance-check 接线 + 付费伦理硬边界 + 防沉迷（8 岁以下禁付/限额）/版号/IAP 联动。

### 数据驱动运营（新增）
- 新增 `references/knowledge/operations/analytics-ops.md`（新建 `operations/` 目录）：KPI 定义（D1/D7/DAU/MAU/ARPU/LTV/付费率/eCPM，区间标注"参考需验证"）+ 隐私优先埋点（PIPL 联动）+ 平台数据合规分流 + 看板方法论。**0 第三方 BI 依赖**（与"轻量精准互补"纪律一致）。

### 无障碍合规（新增）
- 新增 `references/knowledge/compliance/accessibility.md`：色觉/听觉/运动/认知/适老化五类适配清单，与 accessibility-gate 联动；真机验证交用户/专业服务。

### 新增闸门（tests/）
- `tests/balance-gate.mjs`：读 `balance-spec.json`，复用 `balance-check.mjs` 的 `runBalance` 零重复；规格缺=skip/warn（提示先生成规格），越阈=硬失败（exit 1），绝不假 pass。支持自检模式验证子系统接线。
- `tests/accessibility-gate.mjs`：色盲字面静态扫描（纯红/纯绿状态区分风险）+ `accessibility-checklist.md` 五类章节校验；风险=warn 不阻断，绝不标 pass；真机验证交用户。支持自检模式。

### 文档联动
- SKILL.md：版本 1.0.8→1.0.9（frontmatter + metadata）；执行工具计数 25→27（scripts/ 27 + lib 5 = 32 个 .mjs）；工具速查/执行工具清单/质量闸门清单补 balance-check/qa-plan/balance-gate/accessibility-gate；知识路由补 game-design(economy-balance)/operations(analytics-ops)/compliance(accessibility)；端到端链路补数值评审步。
- execution-protocol.md：执行工具清单补 balance-check/qa-plan；新增「流程7：数值评审与运营复盘」；知识层联动补 economy-balance/accessibility/analytics-ops；降级策略补两工具（纯计算/纯文件，不降级）。
- 更新日志补回缺失的 v1.0.8 条目（此前仅 CHANGELOG 记录），闭合五处一致。

### 验证矩阵
- balance-check 跑 drop/economy/difficulty 三模型产出报告（纯计算，无 CLI 依赖）。
- 新闸门自检模式全绿；项目模式 skip/pass/warn/fail 四态验证（越阈真失败、规格缺真 skip）。
- 全 mjs 语法 OK；工具计数自校验 27==27==27；manifest SHA-256 自洽；0 外部依赖；0 残留；`.workbuddy` 不进包。

### 回退基线
- 保留 `小游戏开发专家1.0.8.zip` 作回退基线；若本版回归可回退至 1.0.8。

## v1.0.8 (2026-09-03)

### 门控泳道编排器（新增）
- 新增 `scripts/gate-check.mjs`：规模路由门控编排器，把"结构检测 → 包体预算 → QA 闸门 → 原型/切片门控"编排为一道发布门控。
  - `--scale light`（单 gate）/ `full`（双 gate）/ `auto`（默认，按风险路由：monetization 含 `iap` 或多平台 → full，否则保守 light，不假装做过 full gate）。
  - 复用纯函数零重复：`detectProject`（project-detector）/ `auditBudget`+`loadPlatforms`（build.mjs）/ `collectEvidence`+`classifyCompleteness`（playtest-evidence.mjs）。本脚本只做编排 + 路由 + 报告产出。
  - 产出 `production/gate-report.md`（逐层状态表 + human-in-the-loop 边界引用）与 `production/launch-checklist.md`（上线人工清单模板）。
  - **不假 pass**：结构非法 / 超预算 = 硬失败 exit 1；证据不全 / 原型或切片文档缺失 = warn（exit 0，`readyForRelease:false`，gate 绝不标 pass）；每次都落盘报告，不静默。

### 门控泳道定义（新增）
- 新增 `references/knowledge/gate-pipeline.md`：定义 light/full 规模路由门控（小游戏体量少，不照搬 3A 双 gate）；concept-prototype（PIVOT/KILL 判定）/ vertical-slice（合规闸门守护）的小游戏化定义；**端到端 human-in-the-loop 边界表（附录① P0）**——8 步链路每步标 agent 自动 / 用户手动 / CLI 缺失降级，且 agent 不断言"已上架"。

### 多平台构建矩阵（新增）
- 新增 `references/data/build-matrix.json`：微信/抖音/QQ/快手/支付宝/百度/淘宝/快游戏 构建命令与输出差异矩阵。微信/抖音采用官方已核实数据（包体/全局对象/文档基地）；其余标 `pending-verify`，禁止猜测构建命令或包体上限。

### 附录强制修订落实（1.0.8 相关）
- **① P0 端到端边界表**：gate-pipeline.md §五 + SKILL.md「端到端门控链路」显式划清 agent 自动 / 用户手动 / CLI 缺失降级。
- **⑤ P1 规模路由门控**：门控由固定双 gate 改为按风险路由的 light/full（避免对小游戏过度工程、为对齐而对齐）。
- **⑥ P2 工具计数自校验**：SKILL.md 执行工具计数 24→25（scripts/ 25 + lib 5 = 30 .mjs），交付验证含"脚本实际数 == 描述计数 == 清单条目"grep 校验。
- **⑦ P2 项目态不进包**：打包脚本排除 `.workbuddy/`，state 不进 zip。
- **⑨ P2 回退基线**：保留 `小游戏开发专家1.0.7.zip` 作回退基线；本版若回归可回退至 1.0.7。

### 文档联动
- SKILL.md：版本 1.0.7→1.0.8（frontmatter + metadata）；执行工具计数 24→25；工具速查补 gate-check；工具清单补 gate-check；新增「端到端门控链路」小节；引用 gate-pipeline.md。
- execution-protocol.md：新增「流程6：门控泳道（规模路由）」。
- onboarding.md：补「门控路由提示」（按变现/平台规模走 light/full）。
- 版本戳五处一致：SKILL frontmatter/metadata.version、evolve.mjs、scaffold.mjs、user-profile.mjs、ad-law-words/platforms/spec-registry/sensitive-words.json、manifest.json 全部 bump 1.0.8。

### 验证矩阵
- 端到端冒烟（纯净解压副本）：`scaffold → build → playtest-evidence → qa-gate → gate-check` 全链路跑通；gate-check light/full（无文档 warn、有文档 pass）双路径验证。
- 工具计数自校验通过；全 mjs 语法 OK；manifest SHA-256 自洽；0 外部依赖；0 残留；`.workbuddy` 不进包。

## v1.0.7 (2026-09-03)

### 构建出包闭环（新增）
- 新增 `scripts/build.mjs`：封装微信开发者工具 CLI / Cocos / Laya CLI 本地构建。
  - 原生小游戏离线即可组装包（`built:true`，手动递归复制并排除 node_modules/.git 等）；Cocos/Laya 缺引擎 CLI 时优雅降级（`built:false` + 安装提示，绝不伪造）。
  - 包体预算按 `references/data/platforms.json` 平台分流审计（微信 4/30/4MB、抖音 4/16/20/30MB）。**不使用** `package-analyzer.mjs` 的硬编码 4/30（其仅覆盖微信且未分流平台），避免跨平台误判。
  - CLI 缺失 / 引擎 CLI 缺失 → 降级为 `built:false` + `installHint`，exit 0（不中断链路）；项目结构非法 / 真实构建命令失败 → `outputError` exit 1（真错误）。

### 运行时可玩性证据聚合（新增）
- 新增 `scripts/playtest-evidence.mjs`：只读聚合构建物 / 截图 / 日志 / 手动清单，产出 `none` / `partial` / `complete` 完整度；不伪造任何证据。
- 可选 `--init-checklist`：向项目写入手动可玩性清单模板（显式用户动作，非伪造运行时证据）。

### QA 验证闸门（新增）
- 新增 `tests/qa-gate.mjs`：小游戏专用发布闸门。
  - 无 `--project` → 自检模式：验证 build.mjs / playtest-evidence.mjs 存在、语法、关键导出函数（`auditBudget` / `loadPlatforms` / `collectEvidence` / `classifyCompleteness`）可用。
  - 有 `--project` → 结构非法 / 包体超预算 = 硬失败（exit 1）；运行时证据不完整 = warn（exit 0，`readyForRelease:false`，但**绝不标 pass**，杜绝假通过）。
  - 复用 `build.mjs` 的 `auditBudget` 与 `playtest-evidence.mjs` 的 `classifyCompleteness`，零重复逻辑。

### 引擎专家 + 知识缺口检测（新增）
- 新增 `references/knowledge/tech-practices/engine-expert.md`：引擎专家角色（Cocos / Laya / 原生能力边界 + 版本感知）。
- 知识缺口检测：引擎版本超出训练数据覆盖区间时**必须 WebSearch 官方域**（docs.cocos.com / layaair.layabox.com / developers.weixin.qq.com）核实，结论标注 `[已核实-官方]` / `[待核实-需用户确认]` / `[经验-需真机验证]`，禁止凭记忆编造版本敏感 API。

### project-detector 升级
- `inferEngine()` 推断引擎与版本（Cocos 看 settings/library/cc 命名空间；Laya 看 layaair 依赖/Laya. 命名空间；原生看 GameGlobal/canvas），返回 `engine` / `engineVersion` / `engineConfidence` / `engineSignals`，供 onboarding 引擎选型核对与引擎专家消费。

### 人类协作边界表（P0）
- SKILL.md 执行层协议新增 human-in-the-loop 边界表，明确脚手架 / 构建 / 发布 / 真机 / 证据 / 包体 / 资质 / 数据八类能力的"Skill 能做 vs 必须交还用户"，杜绝表面功能与假成功。

### 文档联动
- SKILL.md：版本 1.0.6→1.0.7；执行工具计数按实际文件核验为 scripts/ 24 个 + lib 5 个 = 29 个 .mjs；工具清单/工具速查/质量闸门清单补 build/playtest-evidence/qa-gate；更新日志补 v1.0.7。
- execution-protocol.md：工具表补 build/playtest-evidence；新增「流程5：构建出包闭环」；降级表补 build/playtest-evidence；知识联动表补 build/playtest-evidence/qa-gate 路由。
- onboarding.md：脚手架命令修正为 `--name`/`--out`（非 `--path`）；技术栈改为结构化选项并补 project-detector 推断说明；执行流程补「引擎推断」与「出包与 QA 闸门」步骤。

## v1.0.6 (2026-09-03)

### 工程脚手架（新增）
- 新增 `scripts/scaffold.mjs`：空目录→合规骨架（目录结构 + `game.json` 合规字段 + `game.js` 入口 + 分包配置 + 项目态初始化）。
  - 明确产出为**合规骨架**，不是可运行引擎工程；引擎工程由用户在编辑器中打开骨架后填充。
  - 内置 human-in-the-loop 边界表：区分 agent 自动完成 / 需用户手动 / 仅 CLI 存在时执行，不承诺"已上架"。
- 新增 `references/knowledge/scaffold.md`：脚手架范围说明与边界表。
- 新增 `tests/scaffold-smoke.mjs`：骨架结构与 `game.json` 合规字段冒烟校验。

### 引导增强（深化⑧ 市场契合）
- 目标平台、目标品类、变现模式、技术栈四项改为引导必问，写入用户画像 `platforms` / `genre` / `monetization` / `tech_stack`。
- 脚手架完成后交叉 `market-data.md` 输出该平台该品类的可行性提示（标注"参考，非承诺"）。

### 结构补录（消除表面功能缺口）
- SKILL.md 补齐三节清单：质量闸门（tests/ 9 道）、安全合规库（compliance/ 4 篇）、数据（references/data/ 5 个）。此前这些文件已存在但清单未列，属表面功能缺口。
- 知识库清单补全实际存在但未列出的 4 个文件（error-reference / glossary / traffic-master / scaffold）。
- 执行工具计数按实际文件核验更新：scripts/ 下 22 个可直调执行工具 + scripts/lib/ 下 5 个内部库模块（automator / devtool-cli / output-formatter / project-detector / user-profile，其中 user-profile.mjs 为用户理解持久化 CLI），合计 27 个 .mjs 脚本。

## v1.0.5 (2026-09-03)

### 事实纠错（P0，消除内部自相矛盾 + 平台分流）
- 软著改为「平台 × 变现模式」矩阵：微信 IAA 走《著作权自我声明》非必填、IAP 必填；抖音软著必填；其他平台待官方核实。消除 compliance/modules/compliance.md、decision-trees、submission、onboarding、software-copyright-sop 中"软著全主体必填"硬伤与"必须 vs 建议"内部矛盾。
- 流量主补「主体闸门」：个人主体不可开通流量主，仅企业/个体工商户可（微信）。
- iOS 虚拟支付纠正：微信小游戏官方虚拟支付仅 Android 支持、iOS 标注未开放；`requestVirtualPayment`/`checkIsSupportMidasPayment`/`requestMidasPaymentGameItem` 明确为**小程序** API，禁止套用于小游戏。消除 compliance/module 中"iOS 已开放/走苹果 IAP"错误。
- 包体限制按平台标注：微信 4/30/4MB、抖音 16/20MB(+VP 30MB)，消除 error-reference 与 tech-specs 串用；全技术实践/SDK 指南补 `platform=wechat` 口径与多平台前缀说明。

### 结构整改（P1）
- 新增 `manifest.json`（文件 SHA-256 清单，唯一真源）、`tests/`（8 项拦截闸门）。
- `SKILL.md` frontmatter 补 `metadata.version`。

### 全平台规范核实引擎
- 新增 `references/data/spec-registry.json`（20 条带 platform+layer 双标签事实，单一真源）。
- 新增 `references/data/platforms.json`（微信/抖音/QQ/快手/支付宝/百度/淘宝/快游戏 全局对象前缀 + 官方文档基地 + Tier）。
- 新增 `scripts/verify-specs.mjs`（按平台/维度核实 + 时效闸门，演进自 fetch-official-docs）。
- 新增 `scripts/freshness-check.mjs`（全量时效巡检，演进自 sop-timeliness-check）。
- `fetch-official-docs.mjs` 演进为注册表驱动；SKILL.md 核实纪律加「平台路由前置」。

### 全维度安全合规引擎
- 新增知识：national-law（L1 国家法层）、content-security（L3 内容安全）、copyright-ip（L4 版权）、ad-law（L6 广告法）。
- 新增词库：references/data/sensitive-words.json（7 分类敏感词）、references/data/ad-law-words.json（极限词）。
- 新增扫描：scripts/sensitive-word-scan.mjs、scripts/copyright-asset-scan.mjs。
- tests 新增 sensitive-word-gate / ad-law-gate / ip-compliance-check / map-territory-check / internal-consistency（落成"无敏感词/无违规违法/无冲突"闸门）。
- compliance-scan.mjs RULE-013 接词库（敏感词/极限词外部化）。

### 用户理解自进化层
- 新增 scripts/lib/user-profile.mjs、scripts/feedback-capture.mjs、scripts/evolve.mjs。
- onboarding 接 project-detector 并统一画像存储位置（memory 工具 / 回退 state/）。
- evolution-protocol 删版本稳定性声明，打通学习闭环执行层；state/ 落 `<workspace>/.workbuddy/minigame-dev/`（不进包）。

### 版本一致
- SKILL.md `version` / `metadata.version` / 更新日志 / CHANGELOG / manifest 五处统一为 1.0.5。

## v1.0.4 (2026-08-31)
- 名称由"微信小游戏开发专家"调整为"小游戏开发专家"，slug 调整为 minigame-dev-pro。
- 描述依据真实能力重写，明确以微信小游戏为核心、涵盖跨端经营（App/PC）路径。
- 同步微信官方最新规范：总包上限30MB（主包4MB/独立分包4MB）、流量主门槛UV>500、内容安全服务端接口。
- 修正未成年人防沉迷时段表述、分享奖励规则表述。
- 补充代码层安全扫描规则定义（SCAN-01~03），统一合规编号体系。
