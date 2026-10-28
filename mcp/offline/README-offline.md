# 离线包说明

| 文件 | 说明 |
|---|---|
| `cua-driver-rs-0.38.0-windows-x86_64.zip` | 官方 release 资产（Windows x86_64），MIT 许可，许可见 `LICENSE-cua-driver.txt` |
| `cua-driver-rs-0.38.0-windows-x86_64.zip.sigstore.json` | 官方 Sigstore sidecar（包内同时按 SHA256SUMS 校验） |
| `SHA256SUMS` | 官方资产校验和；`install-mcp.cmd` 选「离线」时会先校验再释放 |
| `bytebase-dbhub-1.2.5.tgz` | dbhub 的 npm 包本体；**依赖仍需联网解析**，完全离线请另带 npm 缓存 |

## 用法

双击 `install-mcp.cmd` → 在 cua-driver 菜单选 `1) 用包内离线版本`。脚本会：

1. 校验 zip 的 SHA256；
2. 默认释放到非系统盘自定义目录；未指定时才回退到 `%LOCALAPPDATA%\Programs\Cua\cua-driver\bin`；
3. 实测 `cua-driver --version`；
4. 询问是否设置开机自启（启动文件夹 VBS）；
5. 注册到 `~/.qoder/settings.json` 的 `mcpServers`（改前自动备份）。

## 不含

- 任何凭据、连接串、机器标识。
- 其他平台的二进制（macOS/Linux 请联网安装）。
