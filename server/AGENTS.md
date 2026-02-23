# Server Agent Guide

This file scopes work under `server/`.

## Focus Areas

- Routing and API entrypoints: `server/src/app.ts`
- Orchestration and dispatch: `server/src/services/orchestrator-service.ts`
- Task actions and validation: `server/src/services/task-action-service.ts`
- MiniMax runtime/tooling: `server/src/services/minimax-runner.ts`, `server/src/minimax/**`
- Persistence: `server/src/data/**`

## Current Expectations

- Keep Task V2 semantics as source of truth.
- Do not reintroduce retired APIs or clarification-era contracts.
- For behavior change, update/add tests in `server/src/__tests__/` in the same commit.

## Useful Commands

```powershell
pnpm --filter @autodev/server build
pnpm --filter @autodev/server test
pnpm --filter @autodev/server test -- --test-name-pattern "task"
```

## Guardrails

- Use `TaskActionError`/domain errors with clear `error_code`.
- Keep events observable (`*_REJECTED`, `*_FAILED`, `*_APPLIED`) when changing flows.
- Avoid touching runtime `data/` unless explicitly doing a test reset.
