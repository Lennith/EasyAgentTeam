# Agent Working Guide

This repository is a `pnpm` monorepo for AutoDev task-driven collaboration.

## Scope

- `agent_library/`: shared types and schemas
- `server/`: backend API and orchestration runtime
- `dashboard-v2/`: current dashboard frontend
- `TeamsTools/`: Team tool docs/templates for workspace bootstrap
- `E2ETest/`: standardized end-to-end regression scripts

## Current Baseline (V2)

- Task protocol is centered on `POST /api/projects/:id/task-actions`.
- Task query is `GET /api/projects/:id/task-tree`.
- Auto dispatch config is `auto_dispatch_enabled` + `auto_dispatch_remaining`.
- Discuss uses `TASK_DISCUSS_REQUEST|TASK_DISCUSS_REPLY|TASK_DISCUSS_CLOSED`.
- Retired APIs remain retired:
  - `POST /api/projects/:id/agent-handoff` -> `410`
  - `POST /api/projects/:id/reports` -> `410`
  - `GET /api/projects/:id/tasks` -> `410`

## Commands

```powershell
# install
pnpm i

# dev
pnpm dev
pnpm dev:legacy

# build
pnpm build
pnpm --filter @autodev/server build
pnpm --filter dashboard-v2 build

# docs/health
pnpm docs:check
pnpm run doctor
pnpm healthcheck

# tests
pnpm test
pnpm --filter @autodev/server test
pnpm --filter @autodev/server run test -- --test-name-pattern "task report"
```

## Engineering Rules

- Use PowerShell-compatible commands; avoid bash-only syntax.
- Use `pnpm --filter` instead of `npm --prefix`.
- Keep TypeScript strict and NodeNext-compatible import paths.
- Prefer adding/adjusting tests with backend behavior changes.
- Do not commit runtime data/log artifacts under `data/projects/**`, `.minimax/**`, `.trae/**`.

## Fast Start for Agents

- If task is backend behavior: start in `server/src/services/` and related tests in `server/src/__tests__/`.
- If task is dashboard adaptation: start in `dashboard-v2/src/` and match `docs/designV2/frontend_dashboard_v2_backend_api_requirements.md`.
- If task is workflow/E2E: use `E2ETest/scripts/` first; avoid ad-hoc scripts.
