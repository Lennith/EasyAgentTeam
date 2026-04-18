# 后端系统与 Project API 规范（最后更新：2026-04-19）

本页只覆盖系统、catalog、project 相关公开 API。  
workflow 专属接口单独定义在 `workflow-runtime.api-spec.md`。

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
