# Provider Runtime 规范（最后更新：2026-04-25）

文档状态：`验证中`

## 范围

本规范描述 provider 运行时、provider profile、模型兼容校验、启动错误归一与 session 级恢复约束。

## 当前正式 provider

- `codex`
- `minimax`

## Provider Profile

- `/api/settings` 返回并接受 `providers.codex` 与 `providers.minimax`。
- 旧 settings 字段继续兼容读写，但内部运行时以 provider profile 作为归一化配置源。
- `providers.codex.cliCommand` 是 Codex CLI 命令的规范字段，旧 `codexCliCommand` 映射到该字段。
- `providers.minimax` 持有 MiniMax API key、API base、默认 model、sessionDir、MCP servers、step/token/output/shell limits。
- 模型选择优先级固定为：dispatch/session 显式模型与 role 配置、provider profile 默认模型、provider hardcoded default。
- mixed E2E baseline 不允许为了模型选择 patch 全局 `minimaxModel`。

## 写入与启动规则

- 写入前必须校验 `provider + model` 组合是否合法。
- 启动前必须再次校验 `provider + model` 组合是否合法。
- provider 配置错误必须归一为稳定错误类型。
- provider 配置错误属于不可重试配置错误，不应被伪装成普通超时或运行失败。
- MiniMax 的上游暂态错误必须归一为稳定 runtime 错误，而不是直接当普通运行失败处理。

## Session 运行时规则

- `codex` session 运行时通过 CLI JSON event 解析 provider session id。
- `codex` project runner 必须把 `thread.started`、`turn.started`、`item.started/item.completed`、`turn.completed` 与终态 TeamTool 工具活动视作有效 heartbeat 信号；尾段关键活动不能被节流吞掉。
- `codex` runner 的 heartbeat 写入失败必须留下内部审计事件，不能静默吞错。
- workflow / session 运行中一旦拿到真实 provider session id，必须写回 authoritative session。
- resume 与 fresh launch 的选择必须基于 authoritative session 当前状态，而不是调用方猜测。
- MiniMax `429`、`500/502/503/504/529`、连接超时、连接重置会归一为 `PROVIDER_UPSTREAM_TRANSIENT_ERROR`。
- `PROVIDER_UPSTREAM_TRANSIENT_ERROR` 属于 `category=runtime`、`retryable=true`。
- project / workflow 命中这类错误后统一落为 `idle + cooldown`，不落 `blocked` 或 `dismissed`。
- project / workflow 的 runner failure transition 使用共享决策规则输出 session 落态、cooldown 与 runtime event payload。
- project session timeout 在真正执行 kill 前必须对 running session 做一次事实重判：如果 heartbeat 已刷新，或同一 session 对当前 task 的最近终态成功事件仍在 trailing 保护窗口内，则本轮 timeout kill 必须跳过。
- `agent-chat` SSE 的 `error` 事件必须直接透出结构化 provider error payload。
- provider error 与 runtime failure 相关对外字段统一使用 snake_case：`next_action`、`raw_status`、`cooldown_until`。

## 兼容边界

- 新写入不再接受 `trae`。
- 旧数据读路径允许把 legacy `trae` 归一化为 `minimax`。
- 兼容归一只存在于读路径；不允许继续产生新的 `trae` 配置。
