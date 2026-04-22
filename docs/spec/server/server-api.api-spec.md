# 后端系统与 Project API 规范（最后更新：2026-04-22）

本页只覆盖系统、catalog、project 相关公开 API。  
workflow 专属接口单独定义在 `workflow-runtime.api-spec.md`。

文档状态：`验证中`

## 系统入口

- `GET /healthz`
- `GET /api/project-templates`
- `GET /api/prompts/base`
- `GET /api/settings`
- `PATCH /api/settings`
- `GET /api/orchestrator/status`
- `GET /api/models`

## Catalog 入口

- `GET /api/agents`
- `POST /api/agents`
- `PATCH /api/agents/:agent_id`
- `DELETE /api/agents/:agent_id`
- `GET /api/skills`
- `POST /api/skills/import`
- `DELETE /api/skills/:skill_id`
- `GET /api/skill-lists`
- `POST /api/skill-lists`
- `PATCH /api/skill-lists/:list_id`
- `DELETE /api/skill-lists/:list_id`
- `GET /api/teams`
- `GET /api/teams/:teamId`
- `POST /api/teams`
- `PUT /api/teams/:teamId`
- `DELETE /api/teams/:teamId`
- `GET /api/agent-templates`
- `POST /api/agent-templates`
- `PATCH /api/agent-templates/:template_id`
- `DELETE /api/agent-templates/:template_id`

## Project Admin / Routing

- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:id`
- `DELETE /api/projects/:id`
- `GET /api/projects/:id/task-assign-routing`
- `PATCH /api/projects/:id/task-assign-routing`
- `GET /api/projects/:id/route-targets`
- `PATCH /api/projects/:id/routing-config`
- `GET /api/projects/:id/orchestrator/settings`
- `PATCH /api/projects/:id/orchestrator/settings`

## Project Task

- `POST /api/projects/:id/task-actions`
- `GET /api/projects/:id/task-tree`
- `GET /api/projects/:id/tasks/:task_id/detail`
- `PATCH /api/projects/:id/tasks/:task_id`

## Project Runtime

- `GET /api/projects/:id/sessions`
- `POST /api/projects/:id/sessions`
- `POST /api/projects/:id/sessions/:session_id/dismiss`
- `POST /api/projects/:id/sessions/:session_id/repair`
- `POST /api/projects/:id/sessions/:session_id/retry-dispatch`
- `GET /api/projects/:id/runtime-recovery`
- `GET /api/projects/:id/inbox/:role`
- `POST /api/projects/:id/messages/send`
- `POST /api/projects/:id/orchestrator/dispatch`
- `POST /api/projects/:id/orchestrator/dispatch-message`
- `POST /api/projects/:id/events`
- `GET /api/projects/:id/events`
- `GET /api/projects/:id/agent-io/timeline`
- `POST /api/projects/:id/locks/acquire`
- `POST /api/projects/:id/locks/renew`
- `POST /api/projects/:id/locks/release`
- `GET /api/projects/:id/locks`
- `GET /api/projects/:id/agent-output`
- `POST /api/projects/:id/agent-chat`
- `POST /api/projects/:id/agent-chat/:sessionId/interrupt`

## 统一错误约束

- 输入非法返回 4xx
- provider/model 不匹配返回稳定错误码，而不是隐式修正
- project `agent-chat` 的 SSE `error` 事件在 provider 错误场景下返回结构化 payload：`code`、`category`、`retryable`、`message`、`next_action`、`details`
- project runtime failure 事件对外字段统一使用 snake_case，包括 `next_action`、`raw_status`、`cooldown_until`

## Project Recovery Read Model

- `GET /api/projects/:id/runtime-recovery`
- 返回固定 shape：
  - `scope_kind`
  - `scope_id`
  - `generated_at`
- `summary`
- `items`
- `summary` 现在固定区分：
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
  - `recovery_attempts`
- `dismiss` / `repair` 的 command contract 统一返回：
  - `action`
  - `session`
  - `previous_status`
  - `next_status`
  - `warnings`
- `repair` 与 `retry-dispatch` 在 `requires_confirmation=true` 时必须显式提交 `confirm: true`
- `retry-dispatch` 请求体必须携带 optimistic guard：
  - `expected_status`
  - `expected_role_mapping`
  - `expected_current_task_id`
  - `expected_last_failure_at`
  - `expected_last_failure_event_id`
  - `expected_last_failure_dispatch_id`
  - `expected_last_failure_message_id`
  - `expected_last_failure_task_id`
- mandatory guard 约束固定为：`expected_status='idle'`、`expected_role_mapping='authoritative'`，并且至少提供 `expected_last_failure_event_id` 或 `expected_last_failure_dispatch_id`；如果 fresh session 仍有 `currentTaskId`，则 `expected_current_task_id` 也为必填
- action policy 与 command guard 必须完全一致：只有 `last_failure_event_id` 或 `last_failure_dispatch_id` 才能单独放开 `can_retry_dispatch`；`last_failure_message_id` 与 `last_failure_task_id` 仅作为展示与增强 guard，不单独放开 retry
- `retry-dispatch` 的普通重试路径默认按 `onlyIdle=true`、`force=false` 执行；公开 API 不暴露 `force` 参数
- `dismiss` 额外返回：
  - `provider_cancel`
  - `process_termination`
  - `mapping_cleared`
- `retry-dispatch` 统一返回：
  - `action`
  - `session`
  - `current_task_id`
  - `dispatch_scope`
  - `accepted`
  - `warnings`
- recovery command 拒绝错误统一使用：
  - `SESSION_RECOVERY_CONFIRMATION_REQUIRED`
  - `SESSION_RETRY_GUARD_REQUIRED`
  - `SESSION_RETRY_DISPATCH_NOT_ALLOWED`
  - `SESSION_DISMISS_EXTERNAL_STOP_UNCONFIRMED`
- retry-dispatch 审计事件按 `SESSION_RETRY_DISPATCH_REQUESTED`、`SESSION_RETRY_DISPATCH_ACCEPTED`、`SESSION_RETRY_DISPATCH_REJECTED` 区分；读模型兼容历史 `REQUESTED`
- `SESSION_RETRY_GUARD_REQUIRED` 与 `SESSION_RETRY_DISPATCH_NOT_ALLOWED` 都返回 `409`；前者用于 guard 缺失，后者用于 guard mismatch、policy 不允许或 orchestrator 拒绝
- retry-dispatch 内部会生成 `recovery_attempt_id` 并串到 retry 审计事件与对应的 dispatch started / finished / failed 事件；该字段只用于内部审计，不新增公开请求或响应字段
- `runtime-recovery.items[].recovery_attempts[]` 用于公开展示按 `recovery_attempt_id` 分组的完整恢复历史；它保留 full history，不做 synthetic backfill，并至少返回：
  - `recovery_attempt_id`
  - `status`
  - `integrity`
  - `missing_markers`
  - `requested_at`
  - `last_event_at`
  - `ended_at`
  - `dispatch_scope`
  - `current_task_id`
  - `events`
- `recovery_attempts[].events[]` 至少返回：
  - `event_type`
  - `created_at`
  - `payload_summary`
- `recovery_attempts[].status` 按优先级推导：`rejected > failed > finished > running > accepted > requested`
- `recovery_attempts[].integrity` 只允许 `complete | incomplete`
- `recovery_attempts[].missing_markers` 只使用稳定标记名：`requested`、`accepted_or_rejected`、`dispatch_started`、`dispatch_terminal`
- `dismiss` 现在先写 `SESSION_DISMISS_EXTERNAL_RESULT`，只有外部停止已确认后才写 `SESSION_STATUS_DISMISSED`
- project recovery actionability 由后端 policy 决定，前端不得再按 `status` 自行推导 repair/dismiss 能力
