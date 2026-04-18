# 调试观察页面规范（最后更新：2026-04-16）

## 页面范围

- `#/debug/agent-sessions`
- `#/debug/agent-output`

## 页面消费路径

- `GET /api/projects`
- `GET /api/projects/:project_id/sessions`
- `GET /api/projects/:project_id/agent-io/timeline`
- `GET /api/projects/:project_id/agent-output`

## 页面职责映射

- agent-sessions：按项目查看 session 列表和 project agent IO timeline
- agent-output：按项目查看 agent output 聚合日志，并支持暂停、重置、展开

## 明确边界

- 当前独立 debug 页只覆盖 project 作用域。
- workflow 的聊天和 timeline 观察留在 workflow run 工作区，不复用到本页。
