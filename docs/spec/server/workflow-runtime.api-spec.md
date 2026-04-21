# 后端系统 Workflow Runtime API 规范（最后更新：2026-04-22）

本页只覆盖 workflow runtime 公开 API、恢复接口与错误契约。

## Workflow Runtime 入口

- `POST /api/workflow-runs`
- `GET /api/workflow-runs`
- `GET /api/workflow-runs/:run_id`
- `POST /api/workflow-runs/:run_id/start`
- `POST /api/workflow-runs/:run_id/stop`
- `GET /api/workflow-runs/:run_id/status`
- `GET /api/workflow-runs/:run_id/task-tree`
- `GET /api/workflow-runs/:run_id/task-runtime`
- `POST /api/workflow-runs/:run_id/task-actions`
- `POST /api/workflow-runs/:run_id/messages/send`
- `POST /api/workflow-runs/:run_id/orchestrator/dispatch`
- `POST /api/workflow-runs/:run_id/orchestrator/dispatch-message`
- `GET /api/workflow-runs/:run_id/sessions`
- `POST /api/workflow-runs/:run_id/sessions`
- `POST /api/workflow-runs/:run_id/sessions/:session_id/dismiss`
- `POST /api/workflow-runs/:run_id/sessions/:session_id/repair`
- `POST /api/workflow-runs/:run_id/sessions/:session_id/retry-dispatch`
- `GET /api/workflow-runs/:run_id/runtime-recovery`

## Workflow Recovery Read Model

- `GET /api/workflow-runs/:run_id/runtime-recovery`
- 返回固定 shape：
  - `scope_kind`
  - `scope_id`
  - `generated_at`
  - `summary`
  - `items`
- `summary` 至少包含：
  - `all_sessions_total`
  - `recovery_candidates_total`
  - `running`
  - `blocked`
  - `idle`
  - `dismissed`
  - `cooling_down`
  - `failed_recently`
- `items[]` 至少包含：
  - `role`
  - `session_id`
  - `provider`
  - `provider_session_id`
  - `role_session_mapping`
  - `status`
  - `current_task_id`
  - `cooldown_until`
  - `last_failure_at`
  - `last_failure_kind`
  - `last_failure_event_id`
  - `last_failure_dispatch_id`
  - `last_failure_message_id`
  - `last_failure_task_id`
  - `error_streak`
  - `timeout_streak`
  - `retryable`
  - `code`
  - `message`
  - `next_action`
  - `raw_status`
  - `last_event_type`
  - `can_dismiss`
  - `can_repair_to_idle`
  - `can_repair_to_blocked`
  - `can_retry_dispatch`
  - `disabled_reason`
  - `risk`
  - `requires_confirmation`
  - `latest_events`

## Workflow Recovery Commands

- workflow `dismiss` / `repair` 返回统一 command contract：
  - `action`
  - `session`
  - `previous_status`
  - `next_status`
  - `warnings`
- workflow `retry-dispatch` 返回 `action / session / current_task_id / dispatch_scope / accepted / warnings`
- `repair` 与 `retry-dispatch` 在 `requires_confirmation=true` 时必须显式提交 `confirm: true`
- workflow `retry-dispatch` 请求体必须携带 optimistic guard：
  - `expected_status`
  - `expected_role_mapping`
  - `expected_current_task_id`
  - `expected_last_failure_at`
  - `expected_last_failure_event_id`
  - `expected_last_failure_dispatch_id`
  - `expected_last_failure_message_id`
  - `expected_last_failure_task_id`
- mandatory guard 约束固定为：`expected_status='idle'`、`expected_role_mapping='authoritative'`，并且至少提供 `expected_last_failure_event_id` 或 `expected_last_failure_dispatch_id`；如果 fresh session 仍有 `currentTaskId`，则 `expected_current_task_id` 也为必填
- route 继续兼容 snake_case / camelCase guard key，但 dashboard 不允许发送裸 retry
- workflow `retry-dispatch` 的普通重试路径默认按 `onlyIdle=true`、`force=false` 执行；公开 API 不暴露 `force`
- workflow recovery command rejection 统一返回：
  - `SESSION_RECOVERY_CONFIRMATION_REQUIRED`
  - `SESSION_RETRY_GUARD_REQUIRED`
  - `SESSION_RETRY_DISPATCH_NOT_ALLOWED`
  - `SESSION_DISMISS_EXTERNAL_STOP_UNCONFIRMED`
- `SESSION_RETRY_GUARD_REQUIRED` 与 `SESSION_RETRY_DISPATCH_NOT_ALLOWED` 都返回 `409`；前者用于 guard 缺失，后者用于 guard mismatch、policy 不允许或 orchestrator 拒绝
- workflow retry-dispatch 审计事件按 `SESSION_RETRY_DISPATCH_REQUESTED`、`SESSION_RETRY_DISPATCH_ACCEPTED`、`SESSION_RETRY_DISPATCH_REJECTED` 区分；读模型兼容历史 `REQUESTED`
- workflow retry-dispatch 内部会生成 `recovery_attempt_id` 并串到 retry 审计事件与对应的 `ORCHESTRATOR_DISPATCH_STARTED` / `ORCHESTRATOR_DISPATCH_FINISHED` / `ORCHESTRATOR_DISPATCH_FAILED`；该字段只用于内部审计，不新增公开请求或响应字段
- workflow dismiss 先写 `SESSION_DISMISS_EXTERNAL_RESULT`，仅当 provider cancel 已确认或无需停止时才继续写 `SESSION_STATUS_DISMISSED`
- workflow recovery actionability 由后端 policy 决定；`running` session 默认不允许 `repair_to_idle`

## Workflow Runtime 约束

- workflow runtime failure、provider error 与 SSE 对外字段统一使用 snake_case，包括 `next_action`、`raw_status`、`cooldown_until`
- timeout close 前必须通过 workflow timeout evidence 纯函数判断 `should_close`，并基于 fresh heartbeat / recent terminal report 做 skip 保护
- timeout runtime service 只负责加载数据、执行 close / cancel、关闭 dispatch / run、释放 in-flight gate 与写审计，不在 scanner 内继续堆条件分支
