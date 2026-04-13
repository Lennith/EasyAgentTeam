# Session Management PRD

## 状态

- `实装`

## 目标

Session Management 模块负责展示项目级 Agent Session 的运行状态，并提供可观测、可中断的调试入口。

## 当前有效能力

- 列出项目 Session
- 按状态筛选 Session
- 按 `sessionId` / `role` 搜索
- 中断或修复指定 Session
- 查看 Agent 输出日志

## 当前有效数据语义

`SessionRecord` 中与 provider 相关的字段约束为：

- `provider?: "codex" | "minimax"`
- `providerSessionId?: string | null`
- `agentTool?: string` 仅用于展示，只显示当前受支持 provider

调试日志入口统一使用 `agent-output` 命名，不再使用 provider 偏置名称。

## 兼容规则

- 旧 Session 若持久化为已下线 provider，后端读取时统一归一化为 `minimax`
- UI 不再展示、筛选或创建已下线 provider Session
