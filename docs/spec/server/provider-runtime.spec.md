# Provider Runtime 规范（最后更新：2026-05-05）

文档状态：`实装`

## 范围

本规范描述 provider runtime、provider profile、模型兼容校验、启动错误归一、session 级恢复约束和外部 CLI 边界。

## 当前正式 Provider

- `codex`
- `minimax`
- `dpagent`

## Provider Profile

- `/api/settings` 返回并接受 `providers.codex`、`providers.minimax` 与 `providers.dpagent`。
- `providers.codex.cliCommand` 是 Codex CLI 命令字段。
- `providers.dpagent.cliCommand` 是 DPAgent CLI 命令字段；当前外部 CLI 入口只使用 `dpagent`、`src/cli/dpagent.ts`、`dist/cli/dpagent.js`。
- `providers.minimax` 保留 MiniMax API key、API base、默认 model、sessionDir、MCP servers、step/token/output/shell limits 等凭据与运行配置。
- 模型选择优先级固定为：dispatch/session 显式模型、role 配置、provider profile 默认模型、provider hardcoded default。

## 写入与启动规则

- 写入前必须校验 `provider + model` 组合是否合法。
- 启动前必须再次校验 `provider + model` 组合是否合法。
- provider 配置错误必须归一为稳定错误类型。
- provider 配置错误属于不可重试配置错误，不应伪装成普通超时或运行失败。
- MiniMax 上游暂态错误必须归一为稳定 runtime 错误，而不是直接按普通运行失败处理。

## Session 运行时规则

- `codex` session 运行时通过 CLI JSON event 解析 provider session id。
- `dpagent` session 运行时通过 DPAgent CLI/backend runtime 暴露的 provider observation 更新 provider session id。
- workflow / session 运行中一旦拿到真实 provider session id，必须写回 authoritative session。
- resume 与 fresh launch 的选择必须基于 authoritative session 当前状态，而不是调用方猜测。
- MiniMax `429`、`500/502/503/504/529`、连接超时、连接重置会归一为 `PROVIDER_UPSTREAM_TRANSIENT_ERROR`。
- `PROVIDER_UPSTREAM_TRANSIENT_ERROR` 属于 `category=runtime`、`retryable=true`。
- project / workflow 命中暂态错误后统一落为 `idle + cooldown`，不落 `blocked` 或 `dismissed`。
- project / workflow 的 runner failure transition 使用共享决策规则输出 session 落态、cooldown 与 runtime event payload。
- `agent-chat` SSE 的 `error` 事件必须直接透出结构化 provider error payload。
- provider error 与 runtime failure 相关对外字段统一使用 snake_case，包括 `next_action`、`raw_status`、`cooldown_until`。

## Provider 边界

- 正式 provider 集合为 `codex|minimax|dpagent`。
- `trae` 不再作为 provider id 被读时归一化；写入或 session 注册中出现非 `codex|minimax|dpagent` provider 必须返回 `PROVIDER_NOT_SUPPORTED`。
- DPAgent runtime bootstrapping 使用 `DPAGENT_PORT`、`DPAGENT_ALLOW_MISSING_API_KEY_AT_BOOT`、`DPAGENT_SERVER_URL`；MiniMax provider credential env 名称如 `MINIMAX_API_KEY` 保持不变。
