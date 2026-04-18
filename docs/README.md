# EasyAgentTeam 文档中心（最后更新：2026-04-16）

本目录只保留当前有效的正式文档。

仓库协作规则、上线检测权威流程等过程控制内容仍以根 `AGENTS.md` 为准，不纳入本目录的正式规范层级。

## 文档分层

- `guide/`：给用户和维护者的入口说明
- `prd/`：产品职责、公开能力、当前有效规则
- `spec/`：接口、协议、数据契约、运行时规范
- `logic/`：业务逻辑设计、状态流转、异常恢复
- `ops/`：发布、验证、性能与运维说明
- `contracts/`：结构化契约和 JSON Schema

## 快速入口

- 项目介绍：[guide/what-is-this.md](./guide/what-is-this.md)
- 5 分钟上手：[guide/run-in-5-minutes.md](./guide/run-in-5-minutes.md)
- 平台支持：[guide/platform-support.md](./guide/platform-support.md)
- 普通用户指南：[guide/human-user-guide.zh-CN.md](./guide/human-user-guide.zh-CN.md)
- 外部 Agent 工作区：[guide/agent-workspace.guide.md](./guide/agent-workspace.guide.md)

## 后端文档

- PRD 入口：[prd/server/backend-modules.prd.md](./prd/server/backend-modules.prd.md)
- 统一 API 规范：[spec/server/server-api.api-spec.md](./spec/server/server-api.api-spec.md)
- Workflow API 规范：[spec/server/workflow-runtime.api-spec.md](./spec/server/workflow-runtime.api-spec.md)
- Provider Runtime 规范：[spec/server/provider-runtime.spec.md](./spec/server/provider-runtime.spec.md)
- TeamTool 规范：[spec/server/teamtool.spec.md](./spec/server/teamtool.spec.md)
- 编排选择逻辑：[logic/server/dispatch-selection.logic.md](./logic/server/dispatch-selection.logic.md)
- Reminder 门禁逻辑：[logic/server/reminder-gate.logic.md](./logic/server/reminder-gate.logic.md)

## 前端文档

- 项目工作区 PRD：[prd/dashboard/project-workspace.prd.md](./prd/dashboard/project-workspace.prd.md)
- 项目工作区规范：[spec/dashboard/project-workspace.api-spec.md](./spec/dashboard/project-workspace.api-spec.md)
- Workflow 工作区 PRD：[prd/dashboard/workflow-workspace.prd.md](./prd/dashboard/workflow-workspace.prd.md)
- Workflow UI 规范：[spec/dashboard/workflow-ui.api-spec.md](./spec/dashboard/workflow-ui.api-spec.md)
- Settings UI 规范：[spec/dashboard/settings-ui.api-spec.md](./spec/dashboard/settings-ui.api-spec.md)
- 调试观察规范：[spec/dashboard/debug-observation.api-spec.md](./spec/dashboard/debug-observation.api-spec.md)
- 路由与本地状态规范：[spec/dashboard/routing-and-local-state.api-spec.md](./spec/dashboard/routing-and-local-state.api-spec.md)

## 运维与验证

- Release Gate 说明：[ops/release-gate.sop.md](./ops/release-gate.sop.md)
- Workflow 慢 API 分析：[ops/workflow-slow-api.analysis.md](./ops/workflow-slow-api.analysis.md)
- Release QA 报告：`ops/release-qa/`
