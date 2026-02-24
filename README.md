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

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 9+
- Windows PowerShell environment (current runtime target)

### Install

```bash
pnpm install
```

### Run Backend

```bash
pnpm server
```

or on Windows:

```powershell
.\start_backend.bat
```

### Run Dashboard V2

```bash
pnpm web
```

### Build All

```bash
pnpm build
```

### Tests

```bash
pnpm test:unit
pnpm test:smoke
pnpm test:api
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

