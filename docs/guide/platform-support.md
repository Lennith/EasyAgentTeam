# 平台支持（最后更新：2026-04-25）

文档状态：`验证中`

## 当前状态

- Windows：完整支持，回归覆盖最完整。
- Linux：主产品运行时支持，提供辅助 shell 脚本，但本环境不执行 Linux gate。
- macOS：设计兼容，但验证覆盖仍不足。

## 平台差异

- 运行时 prompt 会根据宿主平台切换。
- MiniMax shell 工具只注册当前平台存在的 shell。
- `codex` 与 `minimax` 的默认 CLI 命令会按平台切换。
- Agent 工作区的 `AGENTS.md` 会按平台输出不同运行提示。

## 当前未完全跨平台的部分

- PowerShell 包装的 E2E 脚本仍以 Windows 为主。
- 部分辅助 gate 脚本仍通过 PowerShell 入口运行。
- Linux shell 脚本只作为可读辅助入口；本轮不执行 Linux 测试，也不把 Linux 结果写入 release QA 结论。
- workflow runtime 的 run-scoped mutation 串行化当前是单 backend / 单进程 process-local lock；不声明支持多个 backend 进程共享同一个 `dataRoot`。

## 使用建议

- Windows 用户优先走 `pnpm dev`、Dashboard 和官方 E2E 入口。
- Linux/macOS 用户优先使用产品运行时和 shell 辅助入口，不把 PowerShell E2E 当成日常主入口。
- 部署 workflow runtime 时保持单 backend 进程持有同一 `dataRoot`；如需多进程部署，必须先引入跨进程锁或事务存储。
