# 项目工作区规范（最后更新：2026-04-23）

## 页面范围

- `#/project/:project_id/:view`

## 共享加载路径

- `GET /api/projects/:project_id`
- `GET /api/projects/:project_id/sessions`
- `GET /api/projects/:project_id/runtime-recovery?attempt_limit=5`
- `GET /api/projects/:project_id/task-tree`
- `GET /api/projects/:project_id/locks`
- `GET /api/projects/:project_id/events`
- `GET /api/projects/:project_id/agent-io/timeline`

## 视图相关写接口

- `POST /api/projects/:project_id/task-actions`
- `PATCH /api/projects/:project_id/tasks/:task_id`
- `PATCH /api/projects/:project_id/routing-config`
- `GET /api/projects/:project_id/task-assign-routing`
- `PATCH /api/projects/:project_id/task-assign-routing`
- `POST /api/projects/:project_id/locks/acquire`
- `POST /api/projects/:project_id/locks/renew`
- `POST /api/projects/:project_id/locks/release`
- `POST /api/projects/:project_id/agent-chat`
- `POST /api/projects/:project_id/agent-chat/:sessionId/interrupt`
- `POST /api/projects/:project_id/orchestrator/dispatch`
- `GET /api/projects/:project_id/orchestrator/settings`
- `PATCH /api/projects/:project_id/orchestrator/settings`
- `POST /api/projects/:project_id/sessions/:session_id/dismiss`
- `POST /api/projects/:project_id/sessions/:session_id/repair`
- `POST /api/projects/:project_id/sessions/:session_id/retry-dispatch`

## 视图映射

- timeline：事件时间线
- chat：agent IO timeline
- session-manager：项目会话列表
- recovery：项目级恢复中心，聚合 cooldown、最近 failure、当前任务、恢复动作与最近恢复审计片段；默认请求有限条 `recovery_attempts`，避免长历史无界渲染
- agent-io：项目输入输出聚合
- agent-chat：项目级 agent chat
- taskboard / task-tree / task-create / task-update：任务树与任务写操作
- lock-manager：锁列表和锁管理
- team-config：路由配置
- project-settings：项目级设置

## 明确边界

- 页面不直接消费已退休的 project task/report/handoff 接口。
- 页面不直接决定编排策略，只展示设置并触发显式动作。
- Recovery 视图只展示后端 policy 允许的动作，不再按 session.status 在前端自行推导 repair/dismiss。
- Recovery 动作命中 `requires_confirmation=true` 时，前端必须显式发送 `confirm: true`，不能只靠本地提示后直接复用原请求。
- Recovery 视图直接消费后端返回的 `can_retry_dispatch / disabled_reason / risk / requires_confirmation / latest_events`。
- Recovery 视图在 retry-dispatch 时直接回填后端返回的 `expected_*` failure context guard 字段，不自行推断 authoritative mapping 或失败上下文。
- `dispatch-message` 属于后端能力，但不是当前项目工作区主页面默认消费路径。
