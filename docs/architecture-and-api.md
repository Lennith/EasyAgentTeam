# Architecture and API Navigation

Use this page as the main navigation after the 5-minute path.

## Runtime Modes and Core API Entry

### Project Runtime

- Main write path: `POST /api/projects/:id/task-actions`
- Main query path: `GET /api/projects/:id/task-tree`
- Runtime observability:
  - `GET /api/projects/:id/agent-io/timeline?limit=200`
  - `GET /api/projects/:id/events`
- Orchestrator control:
  - `GET/PATCH /api/projects/:id/orchestrator/settings`
  - `POST /api/projects/:id/orchestrator/dispatch`

### Workflow Runtime

- Main write path: `POST /api/workflow-runs/:run_id/task-actions`
- Main query path:
  - `GET /api/workflow-runs/:run_id/task-runtime`
  - `GET /api/workflow-runs/:run_id/task-tree-runtime`
- Orchestrator control:
  - `GET/PATCH /api/workflow-runs/:run_id/orchestrator/settings`
  - `POST /api/workflow-runs/:run_id/orchestrator/dispatch`

## Key Implementation Entry Points

- Backend route entry: `server/src/routes/`
- Orchestrator runtime entry: `server/src/services/orchestrator/`
- Task action service entry: `server/src/services/task-actions/`
- Data/repository/runtime entry: `server/src/data/`
- Dashboard integration entry: `dashboard-v2/src/`

## PRD Navigation

- PRD index: `server/docs/ServerPRD_Index.md`
- Orchestrator: `server/docs/PRD_Orchestrator.md`
- Data storage: `server/docs/PRD_Data_Storage.md`
- Task protocol: `server/docs/PRD_Task_Protocol.md`
- Workflow runtime: `server/docs/PRD_Workflow_Runtime.md`
- Routing orchestration: `server/docs/PRD_Routing_Orchestration.md`

## Data Boundary Summary

- Route layer must not open transactions directly.
- Application service owns `UnitOfWork.run(...)` boundaries.
- Mainline writes should pass through repository bundles:
  - project: `ProjectRepositoryBundle`
  - workflow: `WorkflowRepositoryBundle`
- Shared scope seam remains:
  - `resolveScope(...)`
  - `runInUnitOfWork(...)`
  - `runWithResolvedScope(...)`

Boundary review helper:

- `pnpm check:boundaries`
- `pnpm check:boundaries:strict`

## E2E and Gate Navigation

- E2E baseline entry: [E2ETest/README.md](../E2ETest/README.md)
- First-run wrapper: `pnpm e2e:first-run`
- Aggregate baseline: `pnpm e2e:baseline`
- Standard engineering gate: `pnpm gate:standard`
- Gate SOP: [docs/gates/standard-gate-sop.md](./gates/standard-gate-sop.md)

Gate-to-doc index contract:

- JSON contract: `docs/contracts/gate-doc-index.contract.json`
- Manual generation command: `pnpm gate:index`

## Common Change Landing Map

- If you change task action behavior:
  - update `server/src/services/task-actions/**` and related tests
  - sync PRD: `server/docs/PRD_Task_Protocol.md`
- If you change orchestrator routing/dispatch/completion:
  - update `server/src/services/orchestrator/**` and related tests
  - sync PRD: `server/docs/PRD_Orchestrator.md`
- If you change storage/repository/transaction boundaries:
  - update `server/src/data/**` and repository tests
  - sync PRD: `server/docs/PRD_Data_Storage.md`
- If you change public endpoints or payloads:
  - update route handlers + docs contract
  - sync `server/docs/ServerPRD_Index.md` and related module PRD
