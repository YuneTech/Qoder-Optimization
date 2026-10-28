---
name: local-rust-engineering
description: 补充 Rust 所有权、错误、异步并发和测试边界；用于相关 Rust 实现与缺陷，不用于纯文案或只有前端的修改。
license: MIT
metadata:
  origin: local-adaptation
---

# 本地 Rust 工程质量

读取 Cargo.toml/Cargo.lock、rust-toolchain、workspace/features、目标平台和已有构建脚本。选实际 crate 与生产 feature 路径，不机械运行 --all-features；相斥或平台专属 features 不能靠全开验收。

## 实现选择
- 依据是否存储/消费数据选择所有权、借用和 slice，避免用无意义 clone 掩盖生命周期问题。复杂共享状态说明谁持有、何时释放和错误后如何恢复。
- 业务失败通过项目现有 Result 与错误类型保留上下文；不要对可预期失败滥用 unwrap/expect，也不为遵循示例新增 anyhow/thiserror。边界错误转码应保留可诊断原因且避免泄露敏感信息。
- 异步路径检查阻塞 I/O、锁范围、持锁 await、取消/超时和任务生命周期。根据锁类型和真实竞争分析，不把 Arc<Mutex<_>> 当作通用架构。
- 对并发与超时缺陷写能区分成功、超时、取消及资源释放的测试。优先现有 runtime/测试工具；可控时钟/事件同步优于固定 sleep。没有引入相关库的必要时，不机械新增 mock、属性测试或覆盖率工具。
- 集成测试调用 public API；内部逻辑用 unit tests；文档例子涉及可执行接口时检查 doc tests。Tauri/Rust 后端必须验证实际 Rust 命令和桥接路径，Node 测试通过不能替代它。

## 验证证据
按当前工具链与仓库规则选择 fmt/check/clippy/test；新版本 clippy 的既有警告不能未经判断全局改代码或强行设 -D warnings。记录 crate、feature、平台、执行/失败/ignored 数量。安装包、设备或真实服务行为只有跑过才称验证。
