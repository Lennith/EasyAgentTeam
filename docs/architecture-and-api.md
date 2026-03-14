# Architecture / API Details

Use this page after finishing the 5-minute path.

## Core Modules

- `server/`: backend runtime and orchestration APIs
- `dashboard-v2/`: dashboard UI for project/workflow/task/timeline views
- `agent_library/`: shared schema/types
- `E2ETest/`: scenario-based baseline regression scripts

## Runtime Modes

- Project runtime APIs: `POST /api/projects/:id/task-actions`, `GET /api/projects/:id/task-tree`, orchestrator settings/dispatch endpoints.
- Workflow runtime APIs: `POST /api/workflow-runs/:run_id/task-actions`, `GET /api/workflow-runs/:run_id/task-runtime`, `GET /api/workflow-runs/:run_id/task-tree-runtime`.

## Detailed References

- Backend PRD index: `server/docs/ServerPRD_Index.md`
- Orchestrator PRD: `server/docs/PRD_Orchestrator.md`
- Task protocol PRD: `server/docs/PRD_Task_Protocol.md`
- Workflow runtime PRD: `server/docs/PRD_Workflow_Runtime.md`
- Dashboard API/PRD docs: `dashboard-v2/docs/`

## Demo and Gate Entry

- Official demos: [docs/demos/README.md](./demos/README.md)
- Standard gate: [docs/gates/standard-gate-sop.md](./gates/standard-gate-sop.md)
