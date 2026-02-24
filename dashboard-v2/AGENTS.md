# Dashboard V2 Agent Guide

This file scopes work under `dashboard-v2/`.

## Backend Contract Source

- Primary contract doc: `docs/designV2/frontend_dashboard_v2_backend_api_requirements.md`
- Current task read API: `GET /api/projects/:id/task-tree`
- Current task write API: `POST /api/projects/:id/task-actions`

## Working Rules

- Treat Dashboard V2 as the active UI; do not depend on Dashboard V1 behavior.
- Prefer adapting UI to backend V2 contract instead of adding compatibility shims.
- Keep role-first UX; session id is technical detail.

## Useful Commands

```powershell
pnpm --filter @autodev/dashboard-v2 build
pnpm --filter @autodev/dashboard-v2 typecheck
```

## Notes

- If backend fields are ambiguous, verify with real API responses from `127.0.0.1:43123` before coding.
- Keep timeline/task-tree rendering resilient to partial payloads.
