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

3. In another terminal, run the first-run demo command.

```powershell
pnpm demo:first-run
```

## Expected Evidence

After success, verify:

1. Task tree API has a DONE task:

```text
GET /api/projects/demo_project_mode_v1/task-tree
```

2. Timeline API contains dispatch and report behavior:

```text
GET /api/projects/demo_project_mode_v1/agent-io/timeline?limit=200
```

3. Workspace has exported evidence:

```text
<workspace>/docs/demo/project/run_summary.md
```

If this path fails, run [standard gate SOP](./gates/standard-gate-sop.md) for diagnostics.
