# Server PRD 索引文档

本文档为 `server/docs` 的后端 PRD 索引，已按当前源码（`server/src/**`）对齐。

## 核心模块 (P0)

| 序号 | 模块名称 | 文件路径 | 优先级 | 状态 | 对应源码 |
|---|---|---|---|---|---|
| 1 | 编排器模块 | `server/docs/PRD_Orchestrator.md` | P0 | ACTIVE | `server/src/services/orchestrator-service.ts` |
| 2 | 路由与消息编排模块 | `server/docs/PRD_Routing_Orchestration.md` | P0 | ACTIVE | `server/src/services/manager-message-service.ts` `server/src/services/routing-guard-service.ts` `server/src/services/project-routing-snapshot-service.ts` |
| 3 | 任务协议模块（Task V2） | `server/docs/PRD_Task_Protocol.md` | P0 | ACTIVE | `server/src/services/task-action-service.ts` `server/src/data/taskboard-store.ts` `server/src/services/task-tree-query-service.ts` `server/src/services/task-detail-query-service.ts` |
| 4 | MiniMax Tools 模块 | `server/docs/PRD_MiniMax_Tools.md` | P0 | ACTIVE | `server/src/minimax/tools/**` `server/src/services/minimax-teamtool-bridge.ts` |
| 5 | MiniMax Agent Loop 模块 | `server/docs/PRD_MiniMax_AgentLoop.md` | P0 | ACTIVE | `server/src/minimax/agent/Agent.ts` `server/src/minimax/llm/LLMClient.ts` |

## 重要模块 (P1)

| 序号 | 模块名称 | 文件路径 | 优先级 | 状态 | 对应源码 |
|---|---|---|---|---|---|
| 6 | Session 管理模块 | `server/docs/PRD_Session_Management.md` | P1 | ACTIVE | `server/src/data/session-store.ts` `server/src/app.ts`（sessions 路由） |
| 7 | 运行时配置模块 | `server/docs/PRD_Runtime_Settings.md` | P1 | ACTIVE | `server/src/data/runtime-settings-store.ts` `server/src/app.ts`（/api/settings） |
| 8 | 调试与时间线模块 | `server/docs/PRD_Debug_Services.md` | P1 | ACTIVE | `server/src/services/agent-debug-service.ts` `server/src/services/agent-io-timeline-service.ts` |
| 9 | 领域模型模块 | `server/docs/PRD_Domain_Models.md` | P1 | ACTIVE | `server/src/domain/models.ts` |
| 10 | 数据存储模块 | `server/docs/PRD_Data_Storage.md` | P1 | ACTIVE | `server/src/data/**` |
| 11 | MiniMax 支撑模块 | `server/docs/PRD_MiniMax_Support.md` | P1 | ACTIVE | `server/src/services/minimax-runner.ts` `server/src/minimax/index.ts` `server/src/minimax/storage/**` |

## 退役说明（硬切）

以下接口/语义已退役，仅用于历史追溯：

- `POST /api/projects/:id/agent-handoff` -> 410
- `POST /api/projects/:id/reports` -> 410
- `GET /api/projects/:id/tasks` -> 410
- `/messages/send` 中 `mode=TASK_ASSIGN` -> 410

当前任务写入统一使用：

- `POST /api/projects/:id/task-actions`

## 文档维护规则

1. PRD 与源码一一对应，新增 service 或新增关键 API 必须在本索引登记。
2. 任何接口硬切后，需要同步更新本索引中的退役说明。
3. 文档状态仅使用：`ACTIVE` / `DEPRECATED` / `DRAFT`。
