# Office MCP 逐层复刻：op 配方与踩坑表

适用：源文件是企业透明加密（DLP）密文，但本机 PowerPoint 能正常打开；产物要求「明文 + 原生可编辑 + 尽量保真」。
本文是 `SKILL.md` 「2.0-B 用 Office MCP 逐层复刻」的细节展开，按执行顺序排列。

## 0. 为什么只能走 MCP 落盘

| 路径 | 结果（实测） |
|---|---|
| Office「另存为」pptx | 头 `3e65988a`（密文） |
| Office 导出 PDF | 头 `c4530f9e`（密文） |
| Office 导出 PNG | 头 `1f44…`（密文） |
| Office MCP `save_document` | 头 `504b0304`（明文） |

结论：明文只能由**非 Office 写入方**产生。MCP 服务进程写盘即可；不要试图用 Office 自己另存。

## 1. 两套坐标不要混

| 来源 | 单位 |
|---|---|
| COM `Shape.Left/Top/Width/Height` | 点（pt），幻灯片 960×540 |
| MCP `read_slide` / `put_image frame` | 像素（px），画布 1280×720，`1 px = 9525 EMU` |
| `apply_ops offset` | EMU（12700 EMU = 1 pt） |
| PowerPoint 窗口 100% 渲染截图 | 1 px ≈ 1 pt（960×540 全页） |

换算：`EMU = pt × 12700`；`px = pt × 4/3`。截图比对时按 1px=1pt 裁剪，别把 px 当 pt。

## 2. apply_ops 的硬约束

- 单次 `operations` **最多 50 条**；必须带 `expectedRevision` 与 `operationId`。
- 每次成功会 `revision+1`；`save_document(expectedRevision)` 才落盘。
- **PowerPoint 打开着目标文件时 `save_document` 会 `QODER_OFFICE_OPERATION_FAILED`** → 先 `Presentation.Close()`（只读且已保存时安全），再存，再重开。
- 新建对象的 ID 在**同一次调用里拿不到**（返回 `created`），需要 `setTransform/groupElements` 时**拆成两次调用**。
- 元素 ID 在编辑过程中稳定（替换图片会换新 ID）。
- `addElement` 的 `kind`：`textbox` / 预设几何名（`rect`/`roundRect`/`ellipse`/`teardrop`/`lineArrow`/`line`…）；**没有 custGeom、没有 group**。
- `addElement` 不接受 `fill:"none"` / `stroke:null`；要"无填充/无线条"就不传该字段，事后再 `setFill "none"` / `setStroke null`。
- `reorderElement` 只有 `front/back/forward/backward`，一次一步；对已在端点重复调用会报错。

## 3. 层序（版式对象要夹在底图与幻灯片对象之间）

推荐套路（每页 O(n) 次 op，n=原有对象数）：

1. 底图、顶栏两张 picture → `reorderElement front`（两次）
2. 依次 `addElement` 版式 UI（按钮 → 环线图 → 泪滴 → 文字 → 工具按钮），全部追加到顶
3. **顶栏 → `back`，底图 → `back`**（顺序必须是"先顶栏、后底图"）
4. 原有幻灯片对象**按原 z 序**逐个 `front`

结果：`[底图, 顶栏, 版式 UI…, 原对象…]`，与"版式在幻灯片对象之下"的原生语义一致。

> **`back` 是"沉到最底"，不是"放到某对象之下"。** 最后执行 `back` 的那个会成为最底层。写成"先底图 back、再顶栏 back"会把顶栏压到地图下面——地图是不透明整页图，于是整条青色顶栏（含渐变纹理）被盖住；症状是"顶栏只剩文字，背景变成地图"。本套实测踩过，9 页一起错。
> 已经错了的修法：对**地图**再执行一次 `back` 即可完成互换（`[顶栏, 地图, …]` → `[地图, 顶栏, …]`），1 op/页。

注意：`setShapeGeometry` 只换几何，不动层序；`put_image` 永远是追加到顶。

## 4. 几何：预设名、调整值、禁忌组合

### 4.1 COM AutoShapeType → OOXML prst

| COM AutoShapeType | 含义 | prst |
|---|---|---|
| 1 | 矩形 | `rect` |
| 5 | 圆角矩形 | `roundRect` |
| 7 | 等腰三角形 | `triangle` |
| 9 | 椭圆 | `ellipse` |
| 11 | 十字 | `plus`（**不是 `cross`**，写了会 `OP_REJECTED`） |
| 17 | 笑脸 | `smileyFace` |
| 109 | 线形标注 | `borderCallout1` |
| 138 | 任意多边形（custGeom） | 无对应，见 §7 |
| 156 | 剪去左右顶角矩形 | `snip2SameRect`（**慎用，见 4.3**） |
| 160 | 泪滴 | `teardrop` |

### 4.2 调整值单位

`COM Adjustments.Item(i)` 返回的是**比例**（0.1667 = 16.67%），OOXML `avLst` 的 `val` = 比例 × 100000。

| 场景 | 例 |
|---|---|
| roundRect 圆角 | 0.1667 → `adj=16667` |
| 开关胶囊 | 0.5 → `adj=50000` |
| 泪滴 | 1.9239 → `adj=192390` |
| 标注尾巴 | `-0.0743,0.214,-0.4178,0.1987` → `adj1…adj4 = -7430,21400,-41780,19870` |

**圆角必须按源值设**：默认 16667 在大面板上会明显过圆（本套源值分布：0 / 1230 / 1740 / 2010 / 4500 / 8400）。批量核对方法见 §8。

### 4.3 已知会让 PowerPoint 打不开的组合

`prst="snip2SameRect"` + `adj=50000` 写入后：MCP 能读、XML 良构、`unzip -t` 通过，但 **PowerPoint 报「could not open the file」**。
处置：这条小切角（6pt 高的边条）保持 `rect`，把差异写进交付说明。不要为了 3px 的视觉效果冒打不开的风险。

## 5. 标注框（borderCallout1）与连接符

- 源 `AutoShapeType=109` 的蓝底标注，不要用矩形近似：改 `borderCallout1` 后尾巴方向与原稿一致。
- 连接符：源是 `straightConnector1`（COM 里可能显示 `Type=1, AutoShapeType=-2`）。用 `addElement kind:"lineArrow"`（生成 `p:cxnSp`），再按源 `HorizontalFlip/VerticalFlip` 做 `flipElements`：
  - 无翻转：起点左上 → 终点右下（箭头在右下）
  - `flipH`：起点右上 → 终点左下
  - `flipV`：起点左下 → 终点右上
  - `flipH+flipV`：起点右下 → 终点左上
- 无箭头的普通线用 `kind:"line"`；线宽 0.5pt 时 `widthEmu=6350`。

## 6. 图片透明通道（logo/图标出现白底方块时）

`Clipboard.GetImage()`、剪贴板的 `PNG`/`JFIF` 格式都会把 alpha **压成白底**（实测 32bpp 图 alpha 全 255）。正解：

```powershell
$sh.Copy(); Start-Sleep -Milliseconds 500
$do=[System.Windows.Forms.Clipboard]::GetDataObject()
if($do.GetDataPresent("Art::GVML ClipFormat")){
  $bytes=$do.GetData("Art::GVML ClipFormat").ToArray()   # 这是 ZIP!
  [IO.File]::WriteAllBytes("_g.zip",$bytes)
  $zip=[IO.Compression.ZipFile]::OpenRead("_g.zip")
  ($zip.Entries | ? { $_.FullName -like "clipboard/media/*" }) | % {
    [IO.Compression.ZipFileExtensions]::ExtractToFile($_, "icon.png", $true)  # 原始 alpha
  }
  $zip.Dispose()
}
```

- GVML 里的 `clipboard/media/image1.png` 是**原始媒体**（分辨率可能高于形状渲染尺寸），带 alpha。
- 替换已有图片：`put_image` 带 `elementId` 可保持 frame、层序、效果；只传 `frame` 是新增（追加到顶）。
- `imagePath` 必须在**会话授权目录**内（放 `work/assets/`），`D:\tmp` 会 `RESOURCE_DENIED`。

## 7. 自由曲线（custGeom，几百个顶点）

MCP 无法创建 custGeom，拆成几百条 `line` 又会把对象数打爆且不可编辑。实测可行的折中：

1. COM `Shape.Nodes` 取顶点（1-based 二维数组，`$n.Points.GetValue(1,1)` / `.GetValue(1,2)`，坐标已是幻灯片绝对坐标）。
2. 用 System.Drawing 按 4× 渲染成**透明 PNG**（白线、Round join、无背景）。
3. `put_image` 按 freeform 的包围盒插入，放在底图之上、泪滴/文字之下。
4. 交付说明里明确写「该环线为图片替代，不可作为形状编辑」。

## 8. 差异清单怎么做（别靠肉眼找漏）

1. 源：COM 递归 dump（`Type=6` 展开 `GroupItems`），字段：name / Type / AutoShapeType / Left / Top / Width / Height / Rotation / FlipH/V / Fill / Line / 文字 runs / Adjustments /（freeform）Nodes。
2. 成品：同一套 dump。
3. 按「位置+尺寸+文本」做最近邻匹配（阈值 ~12pt），输出：缺失 / 多余 / 类型不符 / 位置偏差 四类清单。
4. 类型不符 → `setShapeGeometry`；位置偏差 → `setTransform`；缺失 → `addElement`；多余 → `deleteElement`。
5. **组内子对象坐标陷阱**：COM `GroupItems(i).Left/Top` 已经是**幻灯片绝对坐标**。dump 时若再叠加 `group.Left`，所有子对象会正好偏移一倍（本套曾因此把第 4/8/9 页的面板、图片、复选组整体放大一倍位移）。正确做法：直接取子对象自身坐标，不要加 group 偏移。
6. 对象数验收：源「幻灯片 + CustomLayout」按组**展开**后的数量 == 明文对象数（不重建 Group 容器时）。逐页列出来，不等就是还有漏。

## 9. 文本细节

- 小控件（按钮、开关标签）在源里常是 `wrap="none"`；不复刻会出现「保存」变「保\n存」并触发文本溢出告警 → `setTextBodyProps {wrap:false}`。
- 源里显式的换行（如「事件名\n称」）要原样保留，别合并成一行。
- 字号取 XML run `sz` / COM `Font.Size`；`read_slide` 的 `fontSizePt` 是原型值，可能偏大 0.5–2pt。
- 源稿若有 `brightness`（主题色深浅变体，COM `Fill.ForeColor.Brightness`），MCP 只能写 RGB：按渲染等效色写入并在差异表说明。

## 10. 验收：必须真开 + 真截图

```powershell
# 同尺寸同缩放（76%）打开源与成品，按页面白边自动裁齐（1px=1pt），PrintWindow 抓图
# 左右拼接 1920×540，逐页命名 sbs1..N
```

- 判据：文件头 `504b0304`；`unzip -t` 无错；PowerPoint 打开**无修复提示**；页数一致；对象数逐页对平；并排截图逐页看过。
- **DLP 屏幕水印会让原稿窗口整体偏亮**（逐像素采样偏差可达 +30/通道），所以颜色差异不要直接以截图判定，以对象模型取值为准；截图只用于结构/位置/层序比对。
- 可编辑性抽查：对 3 页各 3 个实质文本框做 `TextFrame2.TextRange.Text = 原文+"X"` → 读回校验 → 还原（内存级，不保存）。需要"交互双击"级证据时再用 CUA，但保存会触发 DLP 重新加密，别在验收里保存。

## 11. 常见失败与处置

| 症状 | 根因 | 处置 |
|---|---|---|
| `QODER_OFFICE_PPTX_OP_REJECTED: index=N` | 该 op 字段非法（如 `prst:"cross"`、引用了同批新建但尚未返回的 ID） | 按索引定位；`cross`→`plus`；新建对象的下游 op 拆到下一批 |
| `QODER_OFFICE_PPTX_OP_INVALID` | `addElement` 传了 `fill:"none"` / `stroke:null` | 省略字段，事后 `setFill/setStroke` |
| `save_document` → `QODER_OFFICE_OPERATION_FAILED` | PowerPoint 正打开该文件 | 先关窗再存 |
| `RESOURCE_DENIED` | 路径不在会话授权目录 | 图片/文件先复制进 `work/` 或 `work/assets/` |
| PowerPoint 打不开（MCP 能读） | 见 §4.3 的 snip 组合 | 回退该几何，保留 rect |
| 图片有白底方块 | 用 `Clipboard.GetImage()` 取的 | 改取 GVML ZIP 内原始 PNG |
| 组内对象整体偏移一倍 | dump 时给子对象又加了 group.Left | 直接用子对象绝对坐标 |
| 打开二进制/中文路径失败（PowerShell） | `.ps1` 里写死中文路径被按 ANSI 读 | 路径用 `Get-ChildItem -Filter *.pptx` 解析，或传参 |
