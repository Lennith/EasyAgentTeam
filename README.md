# EasyAgentTeam

Task-driven multi-agent collaboration framework for software delivery.

This repository contains the backend runtime, shared schemas, dashboard-v2, workspace bootstrap templates, and E2E scripts for running role-based agent teams on local workspaces.

## Product Overview

EasyAgentTeam supports two execution modes:

- Project mode: task-first collaboration inside a concrete project workspace.
- Workflow mode: phase-level orchestration where role agents decompose and execute work inside a workflow run workspace.

The current product surface includes:

- Task V2 protocol centered on `POST /api/projects/:id/task-actions`
- Project and workflow orchestrators with reminder, redispatch, hold, and dispatch-budget controls
- Agent registry with `summary` and `skill_list`
- Local skill import, standardization, and reusable skill lists
- Team routing configuration for message routing, task assignment routing, discuss rounds, and per-agent provider/model selection
- Session lifecycle management, timeline/event inspection, and agent chat
- MiniMax runtime skill injection for imported local skills

## Repository Layout

- `server/`: Express backend, orchestration runtime, storage, provider dispatch, and API endpoints
- `dashboard-v2/`: current React + Vite dashboard
- `agent_library/`: shared TypeScript types and schemas
- `TeamsTools/`: workspace bootstrap templates and team tool documents
- `E2ETest/`: standardized PowerShell end-to-end regression scripts
- `data/`: runtime data for projects, workflow runs, agents, skills, sessions, and events

## Dashboard Navigation

Dashboard v2 is organized as L1 modules:

- `Home`: orchestrator health
- `Projects`: project list and project workspace
- `Workflow`: workflow templates, runs, and run workspace
- `Teams`: team registry and team editor
- `Skills`: skill library and skill lists
- `Agents`: agent sessions, registry, and templates
- `Debug`: debug sessions and logs
- `Settings`: runtime and provider settings

### Project Workspace Tabs

- `timeline`
- `chat`
- `session-manager`
- `agent-io`
- `agent-chat`
- `taskboard`
- `task-tree`
- `task-create`
- `task-update`
- `lock-manager`
- `team-config`
- `project-settings`

### Workflow Run Workspace Tabs

- `overview`
- `task-tree`
- `chat`
- `agent-chat`
- `team-config`

### Skills Tabs

- `library`
- `lists`

## Agent Registry

Agent registry is the global source of truth for reusable agent definitions.

Each agent definition includes:

- `agent_id`
- `display_name`
- `prompt`
- `summary`
- `skill_list`
- optional provider override via `provider_id`

Current semantics:

- `summary` is consumed by generated `Agents/TEAM.md` files in project and workflow workspaces.
- `skill_list` is an array of skill list ids, not raw skill ids.
- Project and workflow views consume agent registry data but do not edit agent registry state.

## Skills

Skills are imported from local filesystem paths. A skill package is a directory whose required contract is a `SKILL.md` file at the package root. Any sibling files or nested folders are treated as package dependencies and are copied into the managed skill package.

### Standard Skill Contract

Imported skills are normalized to a standard `SKILL.md` format with YAML frontmatter:

- `name`
- `description`
- `license`
- `compatibility`

Import behavior:

- input may be a directory or a direct `SKILL.md` path
- recursive discovery is supported for directory import
- `opencode`, `codex`, and generic local layouts are recognized
- missing frontmatter fields are auto-filled with warnings
- normalized packages are copied into `data/skills/packages/<skill_id>/`
- same `skill_id` imports overwrite the managed package

### Skill Lists

Skill lists are reusable groups of imported skills.

Each list includes:

- `list_id`
- `display_name`
- `description`
- `include_all`
- `skill_ids`

Resolution rules:

- `include_all=true` dynamically includes all imported skills
- explicit `skill_ids` are appended after the dynamic set
- final resolved skill ids are deduplicated in order across all referenced lists

### Runtime Injection Boundary

Imported skills are injected only on the MiniMax agent runtime path.

Current injected MiniMax paths:

- project orchestrator dispatch
- project agent chat
- workflow orchestrator dispatch
- workflow agent chat

Current non-injected paths:

- `codex`
- `trae`
- external CLI or exe wrappers that do not use the MiniMax prompt composition path

## Project Runtime

Project mode is the task-first runtime for concrete delivery work.

Core characteristics:

- user and agent actions write through Task V2
- task tree and task detail are the primary read APIs
- message routing and task assignment routing are configured at project/team level
- sessions can be registered, dispatched, repaired, and dismissed
- reminders are task-aware and use the shared reminder message body contract

### Project API Baseline

Active endpoints:

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
- `GET /api/projects/:id/events`
- `GET/PATCH /api/projects/:id/orchestrator/settings`
- `POST /api/projects/:id/orchestrator/dispatch`
- `POST /api/projects/:id/orchestrator/dispatch-message`
- `GET/PATCH /api/projects/:id/task-assign-routing`
- lock endpoints under `/api/projects/:id/locks/*`

Retired project endpoints:

- `POST /api/projects/:id/agent-handoff` -> `410`
- `POST /api/projects/:id/reports` -> `410`
- `GET /api/projects/:id/tasks` -> `410`

## Workflow Runtime

Workflow mode runs a phase graph inside a dedicated workspace path and reuses the same task protocol concepts for agent-created subtasks and discussion.

Core characteristics:

- workflow run creation requires `workspace_path`
- top-level workflow tasks remain phase tasks
- role agents can create subtasks through workflow task actions
- runtime state is exposed through `task-runtime` and `task-tree-runtime`
- reminder messages use the same task-aware payload shape as project reminders
- task-bound reminder messages can be redispatched as message dispatches

### Workflow API Baseline

Active endpoints:

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

- `GET /api/workflow-runs/:run_id/step-runtime` -> `410`, use `task-runtime`
- `POST /api/workflow-runs/:run_id/step-actions` -> `410`, use `task-actions`

## Team Configuration

Teams define reusable collaboration topology.

Current team configuration includes:

- team metadata
- `agent_ids`
- `route_table`
- `task_assign_route_table`
- `route_discuss_rounds`
- `agent_model_configs`

Team configuration is consumed by:

- project creation and project workspace routing
- workflow template/run routing
- provider and model selection per team member

## Shared Reminder Contract

Project and workflow reminders now use the same task-aware payload shape.

Reminder body includes:

- `taskId`
- `summary`
- `task`
- `task.write_set`
- `reminder.open_task_ids`
- `reminder.open_task_titles`
- `taskHint`
- `envelope.correlation.task_id`

This allows reminders to carry the current task context instead of a text-only nudge.

## Runtime Data Layout

Important persisted data paths:

- `data/agents/registry.json`
- `data/skills/registry.json`
- `data/skills/lists.json`
- `data/skills/packages/<skill_id>/`
- `data/projects/<project_id>/...`
- `data/workflows/runs/<run_id>/...`

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- Windows PowerShell

### Install

```powershell
pnpm i
```

### Start Local Development

```powershell
pnpm dev
```

### Build

```powershell
pnpm build
pnpm --filter @autodev/server build
pnpm --filter dashboard-v2 build
```

### Test

```powershell
pnpm test
pnpm --filter @autodev/server test
pnpm --filter dashboard-v2 build
```

### E2E

```powershell
E2ETest\scripts\run-reminder-e2e.ps1
E2ETest\scripts\run-workflow-e2e.ps1
```

## Documentation

- Backend PRD index: `server/docs/ServerPRD_Index.md`
- Agent and skill registry backend PRD: `server/docs/PRD_Agent_Skill_Registry.md`
- Orchestrator: `server/docs/PRD_Orchestrator.md`
- Task protocol: `server/docs/PRD_Task_Protocol.md`
- Workflow runtime: `server/docs/PRD_Workflow_Runtime.md`
- Agent management PRD: `dashboard-v2/docs/Agent_Management_PRD.md`
- Skills management PRD: `dashboard-v2/docs/Skills_Management_PRD.md`
- Project management PRD: `dashboard-v2/docs/Project_Management_PRD.md`
- Team management PRD: `dashboard-v2/docs/Team_Management_PRD.md`
- Workflow backend API contract: `dashboard-v2/docs/Workflow_Mode_Backend_API.md`

## License

This project is source-available for non-commercial use.
