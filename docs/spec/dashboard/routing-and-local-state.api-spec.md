# Dashboard 路由与本地状态规范（最后更新：2026-04-16）

## Hash 路由一级分区

- `#/`
- `#/new-project`
- `#/projects`
- `#/project/:project_id/:view`
- `#/teams/:view/:team_id?`
- `#/workflow/...`
- `#/skills/:view`
- `#/agents/:view`
- `#/debug/:view`
- `#/settings`

## Workflow 路由细分

- `#/workflow`
- `#/workflow/runs/new`
- `#/workflow/runs/:run_id/:view`
- `#/workflow/templates`
- `#/workflow/templates/new`
- `#/workflow/templates/:template_id/edit`
- 兼容旧别名：`#/templates/...` 仍映射到 workflow template 路由

## 本地状态

- `dashboard_settings`
  - 当前只保存 `useMockData`
- `dashboard_theme`
  - 保存当前主题
- `dashboard_lang`
  - 保存当前语言

## 轮询约束

- 项目工作区：
  - 主数据轮询约 2 秒
  - mock 数据轮询约 5 秒
- 首页 orchestrator：
  - 约 2.5 秒
- workflow run status：
  - running 时约 3 秒
  - 非 running 时约 10 秒
- workflow run 列表：
  - 存在 running run 时约 5 秒
  - 否则约 12 秒
- workflow orchestrator 状态：
  - 默认约 8 秒

## 明确边界

- 本地状态只保存显示和数据源模式，不保存业务草稿。
- 业务级参数和运行态仍以后端返回为准。
