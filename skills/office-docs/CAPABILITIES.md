# 能力去向（办公室域收敛后）

2026-09-29 技能降量：Office 域原有 5 个技能（`office-docs` / 官方 `Excel---XLSX` / 官方 `docx` / 市场 `excel-export` / 市场 `word-document-organizer`）互相抢触发，收敛为**只留 `office-docs`**。本文件是那 4 个的**能力去向**清单——**停用的只是"自动触发入口"，能力本身没有丢**：常用的已用 Node 重实现（见下），重型的官方脚本原样保留在 `~/.qoder/skills-disabled/` 里可直接调用。

## 一、现在能做什么（都在本技能内，纯 Node）

| 能力 | 入口 | 验证 |
|---|---|---|
| 读 xlsx → markdown / JSON（含列工作表、按范围截断、**读公式原文**） | `node scripts/office.js read-xlsx <文件> [--formulas] [--list-sheets] [--sheet 名] [--range A1:C9]` | `office.js --selftest` |
| 生成 / 改 xlsx（列宽、冻结、数字格式、CSV 直转） | `node scripts/office.js write-xlsx <spec.json> -o out.xlsx` / `set-xlsx` | 同上 |
| 读 / 写 docx（含 Markdown 直转） | `node scripts/office.js read-docx` / `write-docx` | 同上 |
| 主题化排版（公文 / 商务 / 极简 + 目录域 + 页码 + 表格底纹 + 从图片取色） | `node scripts/office-styles.js render …` / `extract-theme` | `office-styles.js --selftest`（76 条） |
| **改既有 docx：解包 / 回包 / 跨 run 文本替换 / 结构校验 / 修订体检与接受** | `node scripts/docx-surgery.js <unpack\|pack\|replace\|validate\|changes>` | `docx-surgery.js --selftest`（11 条） |

`docx-surgery.js` 示例：

```bash
# 看文档内部（改完再回包；XML 原样写出，不动命名空间声明）
node scripts/docx-surgery.js unpack 合同.docx ./unpacked
node scripts/docx-surgery.js pack   ./unpacked 合同-改.docx
# 文本替换：Word 会把一句话拆进多个 <w:r>，本命令按段落聚合后再替换（先单 run，跨 run 兜底）
node scripts/docx-surgery.js replace 合同.docx 合同-v2.docx --find "三十日内" --replace "十五个工作日内"
node scripts/docx-surgery.js validate 合同-v2.docx          # 要件齐全 + 全部 XML 可解析
node scripts/docx-surgery.js changes  合同.docx             # 数修订标记、列作者
node scripts/docx-surgery.js changes  合同.docx --accept 合同-定稿.docx   # 接受修订
```

**边界（别当它是 Word）**：替换会牺牲"被拆散那一段内的局部格式"（跨 run 时把首个 run 作为落点）；`changes --accept` 是正则级实现，遇到嵌套修订 / 修订里带批注请用下面的官方脚本或 Word 审阅。这些边界是**有意标注**，不是待办。

## 二、停用的 4 个技能，能力各自去哪了

| 停用技能 | 它的独有能力 | 现在怎么拿到 |
|---|---|---|
| 官方 `docx` | OOXML 手术脚本：解包/回包美化、**插入批注**、**接受修订**、校验、模板 | ① 常规场景 → 本技能 `docx-surgery.js`（Node，已自测）；② 批注 / 复杂修订 → **官方脚本仍在** `~/.qoder/skills-disabled/docx/scripts/`，可直接调用，见下节 |
| 官方 `Excel---XLSX` | openpyxl 路线：公式/样式/合并单元格/批注/工作簿保真 | 本技能 `read-xlsx --formulas`（读公式原文）+ `write-xlsx`（列宽/冻结/数字格式）；**要 openpyxl 原始能力**时直接写 Python 调 `openpyxl 3.1.5`（已装，用完整路径），不必装回技能 |
| 市场 `excel-export` | JSON spec → xlsx、SQL→Excel 管线 | 本技能 `write-xlsx` 就是这条管线（spec 含多表 / 冻结表头 / 类型列 / 合计）。该技能另有 `SQL_TO_EXCEL_RECIPE.md`，仍在 `~/.qoder/skills-disabled/excel-export/` 里可读 |
| 市场 `word-document-organizer` | 文档整理（目录 / 统一字体样式 / 三套模板） | 本技能 `office-styles.js` 的 `gongwen` / `business` / `minimal` 三主题 + 目录域，覆盖面更全 |

## 三、官方 docx 脚本：保留且**已实测可跑**

停用＝移目录，**不是删除**。官方那套 Python 脚本就在原地，用完整 Python 路径可直接调：

```bash
PY="$LOCALAPPDATA/Programs/Python/Python314/python.exe"      # 本机 Python 3.14.6，不写进 PATH
cd ~/.qoder/skills-disabled/docx/scripts
"$PY" office/unpack.py 文档.docx ./unpacked                   # 解包（含美化与 run 合并）
"$PY" office/pack.py   ./unpacked 文档-回包.docx               # 回包
"$PY" comment.py       ./unpacked 0 "这里要改"                 # 加批注
"$PY" accept_changes.py 输入.docx 输出.docx                    # 接受修订
"$PY" office/validate.py 文档.docx                             # 校验
```

- **实测（2026-09-29）**：`unpack.py` 曾在缺 `defusedxml` 时报 `ModuleNotFoundError`（exit 1）；装好该包后 `unpack` 成功退出 0，`comment.py` / `accept_changes.py` / `office/validate.py` / `office/pack.py` 的 `--help` 也全部 exit 0。补装命令（官方源，别用镜像——本机镜像曾报"无版本"）：`"$PY" -m pip install defusedxml -i https://pypi.org/simple`。
- 想让它**自动触发**（而不是手动调）：`mv ~/.qoder/skills-disabled/docx ~/.qoder/skills/`，即时生效、无需重启。
- `docx` 的部分能力（`soffice.py` 转 PDF / 转 docx）依赖 **LibreOffice**，本机未装 → **这条能力确实缺**，要用先装 LibreOffice 或另想办法，别指望脚本能跑通。

## 四、一句话原则

收敛的是**入口**，不是**能力**：能用 Node 走的走 Node（无 Python、无 PATH 依赖、可自测）；重型的走 `skills-disabled/` 里的官方脚本；两条都不够再谈装回来。装新办公类技能前先看这里——**同域不装第二个**。
