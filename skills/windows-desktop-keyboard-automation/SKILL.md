---
name: windows-desktop-keyboard-automation
description: "往真实 Windows 桌面应用注入按键并证明实际到达了什么，且不碰用户自己的窗口。用于代理必须向原生应用按键或热键、验证 IME 转换、回读应用的文本缓冲、SendInput 返回 0、注入键落在错误窗口。覆盖 x64 INPUT 布局、前台与焦点断言、剪贴板哨兵回读、Windows 11 记事本双进程与会话恢复陷阱、IME 组字缓冲、无损码点重建。只要截图取证用 capture-window.ps1。"
---

# Windows 桌面键盘注入验证

## Overview

用 SendInput 在真实桌面上按键并**证明键落到了哪里**。核心不是会不会按，而是按完之后读数能不能失败——绝大多数事故都出在"注入返回成功、内容其实没变"这一步。

所有结论都来自本机实跑（PS 5.1 / x64 / zh-CN 布局 + 微信输入法）与一次输入法排障会话的取证，读数见文末陷阱表。

## 何时用 / 何时不用

用：需要向原生桌面应用（记事本、编辑框、全局热键）按键；验证输入法转换与候选窗；读取某个应用的正文；排查 `SendInput` 返回 0 或"按键落到别的窗口"。

不用（交给更专门的技能/工具）：

- 网页与浏览器页面输入 → `verify-ui-in-browser`、`tooling-browser-use-viewport`。
- 只要截图取证 → `~/.qoder/scripts/capture-window.ps1`（先 `SetProcessDPIAware`）。
- PowerShell 语法与 Git Bash 转义坑 → `windows-powershell-from-gitbash`、`windows-powershell-scripting-safety`。
- 要管理员权限的注册表/服务改动 → `windows-elevated-changes-from-git-bash`。
- 锁屏状态 → 一律不驱动 GUI（LockApp 持前台，激活必被拒）。

## 五条硬规则

1. **只用自己创建的 scratch 目标**。在自己的进程里起一个 Form+TextBox，注入前先断言它是空的。绝不把 `Ctrl+A`、`Delete`、粘贴这类破坏性动作发给不是自己创建的窗口——Win11 记事本会把**用户上次未保存的内容**恢复进任何新开窗口，把它当"自己的临时草稿"清掉是真实事故。
2. **每批注入前重新断言前台归属**：`GetForegroundWindow()` 必须等于目标 HWND；不等就中止并报告，不重试到"看着成功"。`SetForegroundWindow` 会**静默失败**（返回 False、不报错），失败后键就打在别的窗口上。
3. **注入返回计数不是判据**。判据只能是被注入方的可观察变化——自有控件读 `Text`/`SelectionLength`、外部目标走哨兵剪贴板、都不认就截图。实测 `SendInput` 返回 10/10 而窗口里一个字符都没有。
4. **读数反常就先怀疑"打的不是这个窗口"**，截图定真相再继续；在读数没解释清楚之前，禁止任何写入动作。
5. **收尾只关自己创建的窗口**，剪贴板先存原文、跑完还回去（实测能还原成功）。

## x64 INPUT 结构体（必须 40 字节）

写成 .ps1 用 `-File` 跑，别用 inline `-Command`。代码里的类型宽度是这轮最容易翻车的地方：

```csharp
[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT {
  public int dx; public int dy; public uint mouseData;
  public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
}

[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT {
  public ushort wVk; public ushort wScan;      // ushort，不是 uint
  public uint dwFlags; public uint time;        // uint
  public IntPtr dwExtraInfo;                    // x64 上 8 字节，决定对齐
}

[StructLayout(LayoutKind.Explicit)]
public struct INPUTUNION {
  [FieldOffset(0)] public MOUSEINPUT mi;        // 必须放 MOUSEINPUT，联合体才够 32 字节
  [FieldOffset(0)] public KEYBDINPUT ki;
}

[StructLayout(LayoutKind.Sequential)]
public struct INPUT {
  public uint type;                             // 4 字节 + 4 字节填充
  public INPUTUNION u;                          // 访问路径是 u.ki，不是 ki
}
```

三条必测的自检：

- `Marshal.SizeOf(typeof(INPUT))` 在 x64 必须是 **40**（x86 为 28）。只放 `KEYBDINPUT` 的联合体实测得到 **32**，`SendInput` 直接返回 **0**、`GetLastError` 为 **87**（ERROR_INVALID_SIZE）。**先断言尺寸再注入**，别把 0 当成"应用没反应"。
- 字段路径写 `a[0].u.ki.wVk`。写 `a[0].ki` 会编译不过（`INPUT` 不含 `ki`）。
- `wVk`/`wScan` 用 `(ushort)`、`dwFlags` 用 `uint` 显式转型；C# 不接受 `0u` 隐式转成 `ushort`。

```csharp
[DllImport("user32.dll", SetLastError = true)]
public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

public static uint SendKey(ushort vk, uint flags) {
  INPUT[] a = new INPUT[1];
  a[0].type = 1u;
  a[0].u.ki.wVk = vk;
  a[0].u.ki.wScan = (ushort)MapVirtualKeyW(vk, 0u);
  a[0].u.ki.dwFlags = flags;
  a[0].u.ki.dwExtraInfo = IntPtr.Zero;
  return SendInput(1u, a, Marshal.SizeOf(typeof(INPUT)));   // flags: 0x1 扩展键 0x2 up 0x4 unicode 0x8 scancode
}
```

`GetLastError` 要**紧跟着调用读**，中间别插消息泵——实测插入后被污染成 203。

## 三条发送通道，选错就白测

| 通道 | 事件 | 本机实测 |
| --- | --- | --- |
| 虚拟键 | `wVk=0x41` | SendInput 与 `keybd_event` 都**送达**（KeyDown 触发），但控件侧报 `ProcessKey`、不出字符；中文输入法下会停在组合缓冲里（见陷阱表） |
| Unicode | `wVk=0, wScan=字符, dwFlags=0x4` | 稳定出字（`KeyPress=U+0062`、`.Text=[b]`），不经布局与输入法 |
| 扫描码 | `wScan=0x1E, dwFlags=0x8` | 组合键能送达，但 `Ctrl+A` 在 Win32 EDIT 里仍**不选中**——问题在应用没实现这个快捷键，不在通道 |

结论：**要把确定文本送进去就用 Unicode 通道**；**要测输入法本身就必须发 VK**（否则测的是绕过输入法的路径，结论无效），且预期结果依赖输入法状态，只能按"可观察变化 + 码点"判定，不能预设一定会出汉字。

## 前台与焦点断言

```csharp
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint id, out GUITHREADINFO gti);
```

- 断言 `GetForegroundWindow() == 目标 HWND` 之外，再用 `GetGUIThreadInfo` 取 **hwndFocus**：前台对了、焦点在别的子控件上同样白按。
- 抢前台按"Activate → `BringWindowToTop`+`SetForegroundWindow` → Alt 轻点后重试 → `AttachThreadInput` 兜底"逐级尝试，每级都重读 `GetForegroundWindow()`；**全失败就报 TAKEOVER-REFUSED 停手**，不要盲发消息。
- 打印窗口身份做证据：`GetClassNameW` + `GetWindowTextW` + 进程名。事故里的读数特征是"目标没错、内容反常"，靠身份行才能一眼看出打到了谁。
- 负例夹具要用**两个自己的窗口**（目标 + 一个没有可编辑控件的诱饵）把前台让出去，别拿用户窗口当"别的应用"——实测守卫在诱饵持前台时正确拒绝、目标保持为空。

## 回读与判定

1. 自有目标 → 直接读控件属性（`.Text`、`.SelectionLength`），确定性最高，别绕剪贴板。
2. 外部目标如果是**标准编辑控件**（类名含 `EDIT`，WinForms 算）→ 首选**消息直读**，不经键盘、不经剪贴板、不受输入法影响，跳进程实测可靠：`WM_GETTEXTLENGTH`（0x000E）取长度、`WM_GETTEXT`（0x000D）取正文、`EM_GETSEL`（0x00B0）读选中区间、`EM_SETSEL`（0x00B1，lParam=-1）全选。实测从另一个进程取到 `len=4 text=[xy7q]` 和 `sel=start=0 end=4 len=4`。
3. 外部目标是非标准控件（Win11 记事本就是这样，UIA 也找不到 Edit）→ 才退回**哨兵剪贴板三段式**：写入带随机后缀的唯一哨兵 → 选取 + `Ctrl+C` → 读回；**若仍等于哨兵就说明复制根本没发生**，立即换通道，不许把"没读到"写成"内容为空"。注意本机实测**跳进程注入 `Ctrl+C` 两次都没复制出来**（`EM_SETSEL` 已把选中做到 0-4 仍失败），所以剪贴板只能当兜底且必须带哨兵自证；来源会话在记事本里能读成功，说明该通道成不成**逐应用**不同，跑前先用哨兵自测一次。
4. 需要键盘全选时不要指望 `Ctrl+A`（送达却 `selection-length=0`）；`Ctrl+Home` → `Ctrl+Shift+End` 只在进程内成功过一次，跳进程两次都 `len=0`。**任何选取动作之后必须独立证明选中区间**（`EM_GETSEL` 或 `.SelectionLength`），否则"粘贴替换"会静默变成"插入"。
5. 判定一律用**码点**：逐字符输出 `U+XXXX`，汉字断言写成 `[int]$ch -ge 0x4E00 -and -le 0x9FFF`。**不要**在脚本里写中文字面量或中文正则——脚本编码会把它变成假 FAIL（来源会话就是这么把成功判成失败的）。
6. 跳进程取证据要**同通道同刻**：实测同一时刻目标进程自己写的状态文件还是 `text=[]`，而 `WM_GETTEXT` 已经能读到 `len=4`——对方边写边读的文件必然滞后，拿它当现场读数会得出与真值相反的结论。
7. 读数与眼睛冲突时信眼睛：截图（`capture-window.ps1`）优先于任何程序化读数。

## 陷阱表（每条都有本机读数）

| 陷阱 | 实测读数 | 处置 |
| --- | --- | --- |
| 联合体只放 KEYBDINPUT | `SizeOf=32`、`SendInput` 返回 0、err 87 | 先断言 `==40` 再注入 |
| 字段路径写成 `a[0].ki` | C# 编译错：INPUT 不含 ki | 用 `a[0].u.ki` |
| `GetLastError` 晚读 | 同一调用先 87、插了消息泵后变 203 | 紧跟调用读 |
| SendInput 计数当成功 | `accepted=10` 而 `.Text=[]` | 计数只作旁证，判据看内容 |
| 组合缓冲未提交就读正文 | 注入拼音后 `.Text=[]`，发一个空格提交后同一窗口变 `你好`（U+4F60 U+597D）——不是没收到键，是还没落地 | 读正文或选取之前先提交组合（空格/回车），否则读数必然偏少 |
| 以为 VK 通道不出汉字 | 提交后拿到 U+4F60 U+597D，输入法转换确实发生了 | 测输入法必须走 VK 通道；用 Unicode 通道会绕过输入法，结论无效 |
| IME 状态查前台窗口 | 报 `no-imm-context` | 查 `hwndFocus`，得到 `conv=0x1 alphabetic=True` |
| `SetForegroundWindow` 静默失败 | 来源会话把 `Ctrl+A` 打在 Qoder 自己窗口上，"只读到 2 个字符"（复制的是屏上 IP 片段） | 每批注入前重断言 + 身份行 |
| Win11 记事本会话恢复 | 新开窗口里是用户未保存的 11,424 字符 | 只用自建 scratch；断言初始为空 |
| Win11 记事本双进程 | 启动进程 `MainWindowHandle` 恒为 0 | 按 PID 集合 `EnumWindows` + 轮询句柄（来源会话实测，本轮未复验） |
| `Ctrl+A` 在某些控件不生效 | `selection-length=0`，而 KeyDown 确实收到 `A/Control` | 换 Home/Shift+End 或 `EM_SETSEL`；先证选中再证下一步 |
| 跳进程注入 `Ctrl+C` 不复制 | `EM_SETSEL` 已把选中做到 `start=0 end=4`，剪贴板仍是哨兵 | 外部标准 EDIT 走 `WM_GETTEXT` 直读；剪贴板只当兜底、逐应用先自测 |
| 拿对方进程正在写的文件当现场读数 | 同一时刻状态文件 `text=[]`、`WM_GETTEXT` 已 `len=4` | 判据同通道同刻；跳进程取文件要等终止标记 |
| Delete 不落 | 来源会话中文模式下被吞；本轮两次夹具里 `delete-took-effect=False`（其中一次根本没选中） | 别拿 Delete 清内容；先证选中，再“粘贴替换” |
| 与内置别名同名的函数 | 函数 `Cp` 被 `Copy-Item` 别名遮蔽，报 `-Path` 空串 | 函数名避开 `Cp/Rm/Dir/Ls/Sleep/Ps` 等别名 |
| PS 5.1 剪贴板 API | `TextBox.ContainsClipboardText` 不存在 | 用 `[Windows.Forms.Clipboard]::ContainsText()` |

## 误动用户内容之后

1. **立刻停止对该窗口的一切写入**，改只读探测。
2. 从自己的日志按**逐字符码点**无损重建（转码副本不可靠——实测 67 个字符 GBK 表示不了）。这就是为什么注入前读到的内容要**当场以码点入日志**，它是唯一能回滚的副本。
3. 先做只读逐字符差异比对，报出差异数与位置，**再等用户决定**是否替换；不自动"帮忙恢复"。
4. 把事故与恢复产物路径写进汇报，不隐藏"我碰过用户内容"这件事。

## 自检与验收

跑一组能失败的模式，逐个记退出码：

- 结构体闸门——断言 40，并故意去掉 MOUSEINPUT 证明它变 32 且被 OS 拒绝（否则闸门没有牙）。
- 正例——向自建空 scratch 窗口注入文本，控件属性必须精确相等。
- 负例——前台不是目标时必须**拒绝注入且目标保持为空**；构造不出该状态要报 `NEG-UNCONSTRUCTIBLE`，不许把"跳过"当通过。
- 哨兵——空目标必须报"没复制到内容"。
- 外部目标——另起一个进程持编辑窗，注入进程只拿 HWND（把两个窗口都做成自己的，别拿用户窗口当外部目标）：必须**同时跑消息直读与剪贴板两条通道**并各自报结果——本轮实测前者绿、后者红，只报聚合数就看不见哪一条坏。
- 汇总行逐通道印结果（如 `CHANNEL-RESULT clipboard-first=False direct-message=True`），一条红不能掩盖另一条绿。
- 输入法——按 VK 注入后按码点断言；状态不满足就照实写"未复现 + 当前 conv 状态"。
- 收尾统计只 grep **本轮**产物文件名。实测把上一轮的 `.out` 混进汇总会产出"1/2"和"2/2"并存的自相矛盾结论。
