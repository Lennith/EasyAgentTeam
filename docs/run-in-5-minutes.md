# Run It In 5 Minutes

This path is the minimum success case for a new user.

## Prerequisites

- Node.js 20+
- pnpm 9+
- PowerShell

## Steps

1. Install dependencies.

```powershell
pnpm i
```

2. Start backend + dashboard.

```powershell
pnpm dev
```

3. In another terminal, run the first-run E2E command.

```powershell
pnpm e2e:first-run
```

## Expected Evidence

After success, verify:

1. Task tree API has terminal tasks:

```text
GET /api/projects/:id/task-tree
```

2. Timeline API contains dispatch and report behavior:

```text
GET /api/projects/:id/agent-io/timeline?limit=200
```

3. Workspace has exported evidence:

```text
<workspace>/docs/e2e/<timestamp>/run_summary.md
```

If this path fails, run [standard gate SOP](./gates/standard-gate-sop.md) for diagnostics.
