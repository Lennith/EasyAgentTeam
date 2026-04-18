# 架构与接口导航（最后更新：2026-04-16）

这是一份导航文档，不承担规范定义职责。

## 后端入口

- 路由层：`server/src/routes/`
- 编排器：`server/src/services/orchestrator/`
- 任务动作：`server/src/services/task-actions/`
- Provider 运行时：`server/src/services/provider-runtime.ts`
- 数据与仓储：`server/src/data/`

## 前端入口

- 路由与页面：`dashboard-v2/src/views/`
- API 映射：`dashboard-v2/src/services/api.ts`
- 类型：`dashboard-v2/src/types/`

## 正式规范入口

- 后端 PRD：[docs/prd/server/backend-modules.prd.md](./prd/server/backend-modules.prd.md)
- 后端 API：[docs/spec/server/server-api.api-spec.md](./spec/server/server-api.api-spec.md)
- Workflow API：[docs/spec/server/workflow-runtime.api-spec.md](./spec/server/workflow-runtime.api-spec.md)
- 前端 Workflow UI：[docs/spec/dashboard/workflow-ui.api-spec.md](./spec/dashboard/workflow-ui.api-spec.md)
- TeamTool 协议：[docs/spec/server/teamtool.spec.md](./spec/server/teamtool.spec.md)

## 逻辑设计入口

- Dispatch 选择：[docs/logic/server/dispatch-selection.logic.md](./logic/server/dispatch-selection.logic.md)
- Reminder 门禁：[docs/logic/server/reminder-gate.logic.md](./logic/server/reminder-gate.logic.md)
- Session Authority：[docs/logic/server/session-authority.logic.md](./logic/server/session-authority.logic.md)
- Workflow 工作区联动：[docs/logic/dashboard/workflow-workspace.logic.md](./logic/dashboard/workflow-workspace.logic.md)
