# E2E Dispatch Regression (Task-Driven)

This folder standardizes backend-only end-to-end regression for dispatch behavior.

## Goal

Validate the full task-driven orchestration loop, not only dependency gating:

1. Manager seeds a fixed dependency structure: `A -> B(manager-created placeholder) -> B1`, and `C depends on B`.
2. Pre-gate dispatch checks prove blocked tasks are rejected before dependencies are done.
3. Discuss scenario includes a negative probe: create a task that depends on its parent; backend must reject with `409 TASK_DEPENDENCY_ANCESTOR_FORBIDDEN`.
4. Auto dispatch then drives the project to closure.
5. Core logs are exported and analyzed with fixed pass/fail rules.

## Scenario

Default scenario file:

- `E2ETest/scenarios/a-self-decompose-chain.json`
- `E2ETest/scenarios/team-discuss-framework.json`

## Scripts

- `E2ETest/scripts/run-standard-e2e.ps1`
  Runs the full E2E case through backend APIs.
- `E2ETest/scripts/run-discuss-e2e.ps1`
  Runs the discuss-heavy multi-architect convergence case.
- `E2ETest/scripts/run-multi-e2e.ps1`
  Runs multiple projects concurrently (default: both chain + discuss).
- `E2ETest/scripts/export-core-logs.ps1`
  Exports events/timeline/task-tree/sessions/settings/task-details.
- `E2ETest/scripts/analyze-core-logs.ps1`
  Produces a deterministic analysis report from exported logs.
- `E2ETest/scripts/analyze-discuss-logs.ps1`
  Produces discuss-case deterministic analysis report.

## Quick Start

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-standard-e2e.ps1
```

Run both projects concurrently (default):

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-multi-e2e.ps1
```

Before each run, the script fully resets the workspace directory content (project/runtime/docs all removed), then rebuilds from scratch.

After one run finishes, artifacts are preserved (no post-run cleanup).

Default workspace is:

- `D:\AgentWorkSpace\TestTeam\TestRound20`
- `D:\AgentWorkSpace\TestTeam\TestTeamDiscuss`

Optional parameters:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-standard-e2e.ps1 `
  -BaseUrl "http://127.0.0.1:3000" `
  -WorkspaceRoot "D:\AgentWorkSpace\TestTeam\E2ETestRun" `
  -AutoDispatchBudget 30 `
  -MaxMinutes 75 `
  -PollSeconds 30
```

Multi-run configurable case/workspace example:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-multi-e2e.ps1 `
  -Cases @("chain","discuss") `
  -ChainWorkspaceRoot "D:\AgentWorkSpace\TestTeam\TestRound20" `
  -DiscussWorkspaceRoot "D:\AgentWorkSpace\TestTeam\TestTeamDiscuss" `
  -AutoDispatchBudget 30 `
  -MaxMinutes 75 `
  -PollSeconds 30
```

## Output

By default, artifacts are written into:

- `<workspace>\docs\e2e\<timestamp>\`

Key files:

- `events.ndjson`
- `timeline.json`
- `task_tree_final.json`
- `sessions_final.json`
- `orchestrator_settings_final.json`
- `task_details.json`
- `analysis.md`
- `run_summary.md`

## Pass Criteria (Default)

1. Seeded tasks `A/B/B1/C` exist with correct owners and dependencies.
2. Pre-gate checks show `B1` and `C` are blocked by dependency gate.
3. Discuss negative probe (`dependency == parent`) is rejected with `409 TASK_DEPENDENCY_ANCESTOR_FORBIDDEN`.
4. `B1` and `C` are eventually dispatched later.
5. No unresolved execution tasks remain.
6. No session remains in running state at finish.
7. No `ORCHESTRATOR_DISPATCH_FAILED` event.
8. `list_directory` tool calls are zero.
9. Team tool success rate is at least 80%.
10. `shell_execute` ratio is controlled (<= 40% of all tool calls).
