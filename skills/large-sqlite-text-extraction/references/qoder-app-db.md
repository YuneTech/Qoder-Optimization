# Qoder 桌面端应用库实例

## 文件位置

- 真实数据目录由 `~/.qoder/desktop/storage/stable/location.v1.json` 指定；本机为 `D:\qoder-data\appdata-roaming\com.qoder.app.stable`（`%APPDATA%\com.qoder.app.stable` 是指向它的 junction）。
- 主库：`<数据目录>\main.sqlite`（本机 2026-10-23 约 811MB）；同目录还有 `main.sqlite-wal`，最新写入常先在 WAL 里。
- 自进化建议的**完整描述**存在 `main.sqlite`，不在 `~/.qoder/evolution/`（那是本地自进化台账，只存精简摘要）。

## 本机实测配方

```bash
node ~/.qoder/skills-library/large-sqlite-text-extraction/scripts/scan-binary-text.cjs \
  "/d/qoder-data/appdata-roaming/com.qoder.app.stable/main.sqlite" \
  "<建议名>" --window 3000 --max 5 --filter "create"
```

- 记录格式形如 `建议名create完整描述…`，所以 `--filter "create"` 能滤掉只含名字的命名空间清单。
- 建议名常被 UI 截断（如 `dedupe-evolution-suggestions-int…`），用前缀搜索、不要带省略号。
- 同一条建议在库里可能出现多次（索引表 / 记录体 / 会话 payload），按偏移去重后取最长的那条。

## 已踩过的坑（本机实测）

- 全盘 `grep` 找不到：内容只在应用库；递归 grep 还会超时。
- `readFileSync(main.sqlite).toString()`：直接 `ERR_STRING_TOO_LONG`（文件 811MB）。
- 首批命中是技能名清单：必须加 `--filter`。
- `fsutil` 在 Git Bash 里跑会因 MSYS 路径转换报「错误 123」：用 PowerShell 的 `Get-Item .LinkType/.Target`。
