# EasyAgentTeam

Task-driven multi-agent collaboration framework for software delivery.

This repository contains a backend orchestrator, shared schemas, and a V2 dashboard for running role-based agent teams (PM / Eng Manager / Dev / QA style) on real projects.

## What It Does

- Task-first protocol (`/task-actions`) for create/assign/discuss/report
- Dependency-gated orchestration with auto-dispatch budget controls
- Session lifecycle management (pending -> provider session, dismiss, repair)
- MiniMax-native team tools (direct bridge to backend services)
- Task tree + task detail query APIs for visualization and audit
- Event + timeline observability for replay and debugging
- Workflow mode: high-level phase orchestration with autonomous agent subtask creation

## Repository Layout

- `server/` Express backend (orchestrator, task protocol, routing, runtime settings)
- `dashboard-v2/` React + Vite dashboard
- `agent_library/` shared TypeScript types/schemas
- `TeamsTools/` team tool docs/templates
- `E2ETest/` standardized end-to-end test scripts
- `data/` runtime data (projects, sessions, events)

## Current API Baseline (Hard Cut)

Active:

- `POST /api/projects/:id/task-actions`
- `GET /api/projects/:id/task-tree`
- `GET /api/projects/:id/tasks/:task_id/detail`
- `POST /api/projects/:id/messages/send` (`MANAGER_MESSAGE`, `TASK_DISCUSS_*`)
- `GET/PATCH /api/projects/:id/orchestrator/settings`

Retired (returns `410`):

- `POST /api/projects/:id/agent-handoff`
- `POST /api/projects/:id/reports`
- `GET /api/projects/:id/tasks`

## Workflow Mode (Design and Usage)

### Design Purpose

Workflow mode is used for multi-phase delivery where manager provides an abstract goal, and role agents self-plan and self-decompose under dependency constraints.

Core intent:

- Keep top-level workflow tasks high-level (phase tasks), not micro-managed by manager.
- Let role agents create/assign subtasks through the same task protocol.
- Orchestrator advances phases by dependency gates, messages, reminders, and dispatch budget.
- Preserve full observability (task tree/runtime/sessions/timeline) for diagnosis and replay.

### Core Workflow APIs

- `POST /api/workflow-templates`
- `GET/PATCH /api/workflow-templates/:template_id`
- `POST /api/workflow-runs` (requires `workspace_path`; supports `auto_start`)
- `GET /api/workflow-runs/:run_id/task-tree`
- `GET /api/workflow-runs/:run_id/tasks/:task_id/detail`
- `POST /api/workflow-runs/:run_id/task-actions`
- `POST /api/workflow-runs/:run_id/messages/send`
- `GET/PATCH /api/workflow-runs/:run_id/orchestrator/settings`
- `POST /api/workflow-runs/:run_id/orchestrator/dispatch`
- `POST /api/workflow-runs/:run_id/agent-chat` (SSE)

### Typical Runtime Flow

1. Create a workflow template with phase tasks and dependency graph.
2. Create a workflow run with `workspace_path` and optional `auto_start=true`.
3. Register role sessions for the run (`/workflow-runs/:run_id/sessions`).
4. Send kickoff manager message to phase owner (`/messages/send`).
5. Let orchestrator/agents run; observe via task tree/runtime/sessions/timeline.
6. Validate final phase convergence and artifacts in workspace.

### Example: Create Run (Auto Start)

```json
POST /api/workflow-runs
{
  "run_id": "wf_demo_run_01",
  "template_id": "wf_demo_tpl",
  "name": "Android Gesture App",
  "description": "帮我做一个安卓端的手势识别应用",
  "workspace_path": "D:\\AgentWorkSpace\\TestTeam\\TestWorkflowSpace",
  "auto_dispatch_enabled": true,
  "auto_dispatch_remaining": 5,
  "auto_start": true
}
```

Notes:

- Workflow run is workspace-bound (`workspace_path`), not project-bound.
- `project_id` binding fields are retired for workflow run creation.
- Host project bootstrap is not required for workflow runtime.

### E2E (Brief, Non-Core)

E2E scripts are for regression validation of orchestration behavior, not product runtime dependencies:

- `E2ETest/scripts/run-workflow-e2e.ps1` (workflow case)
- `E2ETest/scripts/run-multi-e2e.ps1` (parallel project + workflow)

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- Windows PowerShell environment (current runtime target)

### Install

```bash
pnpm i
```

### Agent Deployment Checklist

1. Install dependencies

```bash
pnpm i
```

Expected output:

- `Packages:`
- `Done in`

2. Build all packages

```bash
pnpm build
```

Expected output:

- `@autodev/agent-library@0.1.0 build`
- `@autodev/server@0.1.0 build`
- `dashboard-v2@1.0.0 build`
- `✓ built in`

3. Start local dev stack (server + dashboard)

```bash
pnpm dev
```

Expected output:

- `[server] listening on http://127.0.0.1:43123`
- `Local:   http://127.0.0.1:54174/`

4. Run passive health check (do not auto-start services)

```bash
pnpm healthcheck
```

Expected output:

- `status=PASS`
- `reason=all_checks_passed`

5. (Optional) Run baseline tests

```bash
pnpm test
```

Expected output:

- `test:smoke`
- `test:unit`

### Common Failures (and fixes)

| Symptom                      | Reason                                  | Fix                                                                                                       |
| ---------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm: command not found`    | pnpm missing                            | `corepack enable && corepack prepare pnpm@9.12.3 --activate`                                              |
| `node version below minimum` | Node < 20                               | Install Node 20+, then reopen shell                                                                       |
| `healthz_unreachable`        | server not running or wrong port        | `pnpm run dev:server` then re-run `pnpm healthcheck`                                                      |
| `dashboard_unreachable`      | dashboard dev server not running        | `pnpm run dev:web` then re-run `pnpm healthcheck`                                                         |
| `EADDRINUSE` on 43123/54174  | port occupied                           | `Get-NetTCPConnection -LocalPort 43123,54174 \| Select-Object LocalPort,OwningProcess` then stop that PID |
| PowerShell permission errors | execution policy restrictive            | `Set-ExecutionPolicy -Scope Process Bypass`                                                               |
| Path errors on Windows       | workspace path invalid or no permission | move repo/workspace to writable path (for example `D:\work\...`)                                          |

### Stop Conditions (do not keep retrying)

Stop and output diagnostics if any of these conditions are met:

1. Same command fails 3 times with the same error signature.
2. `pnpm run doctor` returns `status=FAIL` for version or lockfile checks.
3. `pnpm healthcheck --json` keeps failing with same `reason` for over 10 minutes.
4. Build fails after reinstall (`pnpm i`) with unchanged error stack.

Diagnostics to collect:

```bash
pnpm run doctor -- --json > doctor.json
pnpm healthcheck --json > healthcheck.json
pnpm docs:check --json > docs-check.json
```

### Tests

```bash
pnpm test
pnpm test:api
pnpm docs:check
```

## Documentation

- Backend PRD index: `server/docs/ServerPRD_Index.md`
- Orchestrator: `server/docs/PRD_Orchestrator.md`
- Task protocol: `server/docs/PRD_Task_Protocol.md`
- Routing & message orchestration: `server/docs/PRD_Routing_Orchestration.md`
- MiniMax tools: `server/docs/PRD_MiniMax_Tools.md`

## UI Preview

Place screenshots under `docs/images/` with the exact filenames below.

### 1) Dashboard Overview

![Dashboard Overview](docs/images/ui-01-dashboard-overview.png)

### 2) Project Detail (Sessions + Routing)

![Project Detail](docs/images/ui-02-project-detail.png)

### 3) Task Tree View

![Task Tree](docs/images/ui-03-task-tree.png)

### 4) Task Detail Drawer

![Task Detail](docs/images/ui-04-task-detail.png)

### 5) Timeline / Events View

![Timeline Events](docs/images/ui-05-timeline-events.png)

### 6) Orchestrator Settings

![Orchestrator Settings](docs/images/ui-06-orchestrator-settings.png)

### 7) Agent Console View

![Agent Console](docs/images/ui-07-agent.png)

### 8) Team Settings

![Team Settings](docs/images/ui-08-teamsetting.png)

## Open Source Readiness Checklist

Before public release, complete:

- Add `CONTRIBUTING.md`
- Add `CODE_OF_CONDUCT.md`
- Add `SECURITY.md`
- Add issue/PR templates in `.github/`
- Add CI workflow for build + tests
- Remove local runtime artifacts from repo (`data/`, `.minimax/`, logs if tracked)
- Publish architecture diagram and API examples
- Pin minimal supported versions (Node, pnpm, OS)

## Status

Active development. Interfaces are stabilizing around Task V2 + MiniMax toolcall workflow.
Not yet production-hardened.

## License

This project is source-available for non-commercial use.

- Default license: see `LICENSE`
- Commercial use: requires separate authorization, see `COMMERCIAL_LICENSE.md`
