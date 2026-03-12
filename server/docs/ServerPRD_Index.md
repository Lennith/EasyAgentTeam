# Server PRD Index

This index reflects the current backend product surface in `server/src/**`.

## Core Modules

| Priority | Module                            | PRD File                                   | Main Source                                                                                      |
| -------- | --------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| P0       | Orchestrator                      | `server/docs/PRD_Orchestrator.md`          | `server/src/services/orchestrator-service.ts`                                                    |
| P0       | Routing and Message Orchestration | `server/docs/PRD_Routing_Orchestration.md` | `server/src/services/manager-message-service.ts`                                                 |
| P0       | Task Protocol                     | `server/docs/PRD_Task_Protocol.md`         | `server/src/services/task-action-service.ts`                                                     |
| P0       | MiniMax Tools                     | `server/docs/PRD_MiniMax_Tools.md`         | `server/src/minimax/tools/**`                                                                    |
| P0       | MiniMax Agent Loop                | `server/docs/PRD_MiniMax_AgentLoop.md`     | `server/src/minimax/agent/Agent.ts`                                                              |
| P1       | Workflow Runtime                  | `server/docs/PRD_Workflow_Runtime.md`      | `server/src/services/workflow-orchestrator-service.ts`                                           |
| P1       | Agent and Skill Registry          | `server/docs/PRD_Agent_Skill_Registry.md`  | `server/src/data/agent-store.ts`, `server/src/data/skill-store.ts`, `server/src/app.ts`          |
| P1       | Session Management                | `server/docs/PRD_Session_Management.md`    | `server/src/data/session-store.ts`, `server/src/app.ts`                                          |
| P1       | Runtime Settings                  | `server/docs/PRD_Runtime_Settings.md`      | `server/src/data/runtime-settings-store.ts`, `server/src/app.ts`                                 |
| P1       | Debug Services                    | `server/docs/PRD_Debug_Services.md`        | `server/src/services/agent-debug-service.ts`, `server/src/services/agent-io-timeline-service.ts` |
| P1       | Domain Models                     | `server/docs/PRD_Domain_Models.md`         | `server/src/domain/models.ts`                                                                    |
| P1       | Data Storage                      | `server/docs/PRD_Data_Storage.md`          | `server/src/data/**`                                                                             |
| P1       | MiniMax Support                   | `server/docs/PRD_MiniMax_Support.md`       | `server/src/services/minimax-runner.ts`, `server/src/minimax/**`                                 |

## Project API Baseline

Current active project endpoints:

- `POST /api/projects`
- `GET /api/projects`
- `GET /api/projects/:id`
- `DELETE /api/projects/:id`
- `GET /api/projects/:id/task-tree`
- `GET /api/projects/:id/tasks/:task_id/detail`
- `POST /api/projects/:id/task-actions`
- `PATCH /api/projects/:id/tasks/:task_id`
- `POST /api/projects/:id/messages/send`
- `GET /api/projects/:id/sessions`
- `POST /api/projects/:id/sessions`
- `POST /api/projects/:id/sessions/:session_id/dismiss`
- `POST /api/projects/:id/sessions/:session_id/repair`
- `GET /api/projects/:id/agent-io/timeline`
- `POST /api/projects/:id/agent-chat`
- `POST /api/projects/:id/agent-chat/:sessionId/interrupt`
- `GET /api/projects/:id/events`
- `GET/PATCH /api/projects/:id/orchestrator/settings`
- `POST /api/projects/:id/orchestrator/dispatch`
- `POST /api/projects/:id/orchestrator/dispatch-message`
- `GET/PATCH /api/projects/:id/task-assign-routing`
- `/api/projects/:id/locks/*`

## Workflow API Baseline

Current active workflow endpoints:

- `GET /api/workflow-orchestrator/status`
- `GET/POST/PATCH/DELETE /api/workflow-templates`
- `GET/POST/DELETE /api/workflow-runs`
- `GET /api/workflow-runs/:run_id`
- `POST /api/workflow-runs/:run_id/start`
- `POST /api/workflow-runs/:run_id/stop`
- `GET /api/workflow-runs/:run_id/status`
- `GET /api/workflow-runs/:run_id/task-runtime`
- `GET /api/workflow-runs/:run_id/task-tree-runtime`
- `GET /api/workflow-runs/:run_id/task-tree`
- `GET /api/workflow-runs/:run_id/tasks/:task_id/detail`
- `POST /api/workflow-runs/:run_id/task-actions`
- `GET/POST /api/workflow-runs/:run_id/sessions`
- `POST /api/workflow-runs/:run_id/messages/send`
- `GET /api/workflow-runs/:run_id/agent-io/timeline`
- `GET/PATCH /api/workflow-runs/:run_id/orchestrator/settings`
- `POST /api/workflow-runs/:run_id/orchestrator/dispatch`
- `POST /api/workflow-runs/:run_id/agent-chat`
- `POST /api/workflow-runs/:run_id/agent-chat/:sessionId/interrupt`

Retired workflow endpoints:

- `GET /api/workflow-runs/:run_id/step-runtime` -> `410`
- `POST /api/workflow-runs/:run_id/step-actions` -> `410`

## Agent and Skill Registry API Baseline

Current active registry endpoints:

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

## Shared Reminder Contract

Project and workflow orchestrators both use the shared reminder message body model defined in `server/src/domain/models.ts` and produced by `server/src/services/reminder-message-builder.ts`.

Reminder payload includes:

- `taskId`
- `summary`
- `task`
- `reminder.open_task_ids`
- `reminder.open_task_titles`
- `taskHint`
- `envelope.correlation.task_id`

Task-bound reminder messages are eligible for message redispatch through `server/src/services/orchestrator-dispatch-core.ts`.

## Hard-Cut Retired Project API

The following project endpoints remain retired and return `410`:

- `POST /api/projects/:id/agent-handoff`
- `POST /api/projects/:id/reports`
- `GET /api/projects/:id/tasks`
- `/messages/send` with `mode=TASK_ASSIGN`

## Documentation Rules

1. PRD files reflect current runtime behavior, not migration notes.
2. New service modules or new public endpoints must be registered here.
3. Status vocabulary stays limited to `ACTIVE`, `DRAFT`, or `DEPRECATED` in module-specific PRDs.
