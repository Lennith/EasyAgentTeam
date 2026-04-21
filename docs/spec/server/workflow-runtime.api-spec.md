# Workflow Runtime API 规范（最后更新：2026-04-19）

## Workflow Template

- `GET /api/workflow-templates`
- `GET /api/workflow-templates/:template_id`
- `POST /api/workflow-templates`
- `PATCH /api/workflow-templates/:template_id`
- `DELETE /api/workflow-templates/:template_id`

## Workflow Run

- `GET /api/workflow-orchestrator/status`
- `GET /api/workflow-runs`
- `POST /api/workflow-runs`
- `GET /api/workflow-runs/:run_id`
- `DELETE /api/workflow-runs/:run_id`
- `POST /api/workflow-runs/:run_id/start`
- `POST /api/workflow-runs/:run_id/stop`
- `GET /api/workflow-runs/:run_id/status`
- `GET /api/workflow-runs/:run_id/task-runtime`
- `GET /api/workflow-runs/:run_id/task-tree-runtime`
- `GET /api/workflow-runs/:run_id/task-tree`
- `GET /api/workflow-runs/:run_id/tasks/:task_id/detail`
- `POST /api/workflow-runs/:run_id/task-actions`
- `GET /api/workflow-runs/:run_id/sessions`
- `POST /api/workflow-runs/:run_id/sessions`
- `POST /api/workflow-runs/:run_id/sessions/:session_id/dismiss`
- `POST /api/workflow-runs/:run_id/sessions/:session_id/repair`
- `POST /api/workflow-runs/:run_id/sessions/:session_id/retry-dispatch`
- `GET /api/workflow-runs/:run_id/runtime-recovery`
- `POST /api/workflow-runs/:run_id/messages/send`
- `GET /api/workflow-runs/:run_id/agent-io/timeline`
- `GET /api/workflow-runs/:run_id/orchestrator/settings`
- `PATCH /api/workflow-runs/:run_id/orchestrator/settings`
- `POST /api/workflow-runs/:run_id/orchestrator/dispatch`
- `POST /api/workflow-runs/:run_id/agent-chat`
- `POST /api/workflow-runs/:run_id/agent-chat/:sessionId/interrupt`

## Workflow 已退役入口

- `GET /api/workflow-runs/:run_id/step-runtime`
- `POST /api/workflow-runs/:run_id/step-actions`

## 关键写入字段

- workflow run 创建使用 `template_id`、`workspace_path`、`mode`、`variables`
- session 写入使用 `role`，可显式带 `provider_id` 与 `provider_session_id`
- session 注册不接受独立 `model` 写入
- orchestrator settings 负责 loop / schedule / reminder / hold 等公开控制参数
- workflow `agent-chat` 的 SSE `error` 事件在 provider 错误场景下返回结构化 payload：`code`、`category`、`retryable`、`message`、`next_action`、`details`
- workflow session 命中 provider 暂态错误时会回到 `idle` 并带 `cooldown_until`，等待后续 reminder / tick 重试
- workflow runtime failure 事件对外字段统一使用 snake_case，包括 `next_action`、`raw_status`、`cooldown_until`

## Workflow Recovery Read Model

- `GET /api/workflow-runs/:run_id/runtime-recovery`
- 返回字段 shape 与 project recovery 保持一致，至少包含：
  - `scope_kind`
  - `scope_id`
  - `generated_at`
  - `summary`
  - `items`
- `items[]` 的恢复信息字段统一使用 snake_case，包括：
  - `session_id`
  - `provider_session_id`
  - `current_task_id`
  - `cooldown_until`
  - `last_failure_at`
  - `last_failure_kind`
  - `last_failure_event_id`
  - `last_failure_dispatch_id`
  - `last_failure_message_id`
  - `last_failure_task_id`
  - `next_action`
  - `raw_status`
  - `can_dismiss`
  - `can_repair_to_idle`
  - `can_repair_to_blocked`
  - `can_retry_dispatch`
  - `disabled_reason`
  - `risk`
  - `requires_confirmation`
  - `latest_events`
- `summary` 统一区分 `all_sessions_total` 与 `recovery_candidates_total`，不再用单一 `total` 混合表示 scope 内 session 总数与 recovery candidate 数量
- workflow dismiss / repair 的 command contract 与 project recovery 对齐：
  - `dismiss` 返回 `action / session / previous_status / next_status / provider_cancel / process_termination / mapping_cleared / warnings`
  - `repair` 返回 `action / session / previous_status / next_status / warnings`
- workflow `retry-dispatch` 返回 `action / session / current_task_id / dispatch_scope / accepted / warnings`
- `repair` 与 `retry-dispatch` 在 `requires_confirmation=true` 时必须显式提交 `confirm: true`
- workflow `retry-dispatch` 请求体允许携带 optimistic guard：`expected_status`、`expected_role_mapping`、`expected_current_task_id`、`expected_last_failure_at`、`expected_last_failure_event_id`、`expected_last_failure_dispatch_id`、`expected_last_failure_message_id`、`expected_last_failure_task_id`
- workflow `retry-dispatch` 的普通重试路径默认按 `onlyIdle=true`、`force=false` 执行；公开 API 不暴露 `force`
- workflow recovery command rejection 统一返回：
  - `SESSION_RECOVERY_CONFIRMATION_REQUIRED`
  - `SESSION_RETRY_DISPATCH_NOT_ALLOWED`
  - `SESSION_DISMISS_EXTERNAL_STOP_UNCONFIRMED`
- workflow retry-dispatch 审计事件按 `SESSION_RETRY_DISPATCH_REQUESTED`、`SESSION_RETRY_DISPATCH_ACCEPTED`、`SESSION_RETRY_DISPATCH_REJECTED` 区分；读模型兼容历史 `REQUESTED`
- workflow dismiss 先写 `SESSION_DISMISS_EXTERNAL_RESULT`，仅当 provider cancel 已确认或无需停止时才继续写 `SESSION_STATUS_DISMISSED`
- workflow recovery actionability 由后端 policy 决定，`running` session 默认不允许 repair_to_idle
