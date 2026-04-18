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
