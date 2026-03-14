# E2E Baseline Regression

This folder is the official scenario entry for orchestration validation, not an auxiliary test set.

## Scope

Supported baseline scripts:

- `E2ETest/scripts/run-standard-e2e.ps1`
- `E2ETest/scripts/run-discuss-e2e.ps1`
- `E2ETest/scripts/run-workflow-e2e.ps1`

Coverage is scenario-first:

- reminder behavior is validated inside all three baselines
- skill import and runtime skill usage are validated inside workflow baseline
- mechanism-only scripts are intentionally excluded from baseline entry

## What Each E2E Validates

- `standard`: project dependency-chain orchestration and close-loop completion
- `discuss`: multi-agent architecture discussion and convergence flow
- `workflow`: workflow template/run/session orchestration plus skill injection evidence
- `multi`: aggregate launcher for `standard + discuss + workflow`

## E2E Usage Template

Use the same structure for every scenario:

1. Purpose
2. Prerequisites
3. Config to replace
4. Command
5. Expected result
6. Common failure points

### Standard Baseline (`run-standard-e2e.ps1`)

1. Purpose

- Validate project-mode dependency, dispatch, reminder, and close-loop completion.

2. Prerequisites

- backend is running and reachable at `BaseUrl`
- provider setup is available (default scenario uses `minimax`)

3. Config to replace

- `BaseUrl`
- `WorkspaceRoot`
- `ScenarioPath` (if using custom scenario)
- scenario fields: `agent_model`, `route_table`, `task_assign_route_table`, `route_discuss_rounds`

4. Command

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-standard-e2e.ps1
```

5. Expected result

- terminal includes `runtime_pass=True` and `analysis_pass=True`
- artifacts include `run_summary.md`, `task_tree_final.json`, and `events.ndjson`
- dashboard `Projects -> task-tree / timeline` matches artifacts

6. Common failure points

- provider is unavailable or key/base/model is not configured
- workspace path is not writable
- role/route mismatch in scenario prevents convergence

### Discuss Baseline (`run-discuss-e2e.ps1`)

1. Purpose

- Validate multi-role discussion path, discuss-round policy, and convergence.

2. Prerequisites

- backend and provider are available

3. Config to replace

- `BaseUrl`
- `WorkspaceRoot`
- `ScenarioPath`
- scenario discuss routing and round policy fields

4. Command

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-discuss-e2e.ps1
```

5. Expected result

- terminal run closes normally
- discussion traffic is visible in timeline
- artifacts include `run_summary.md` and analysis outputs

6. Common failure points

- route/discuss-round policy mismatch
- provider latency causing timeout

### Workflow Baseline (`run-workflow-e2e.ps1`)

1. Purpose

- Validate workflow end-to-end (`template -> run -> sessions -> dispatch -> convergence`) and skill injection path.

2. Prerequisites

- backend and provider are available
- if skill probe is enabled, `/api/skills/import` source path is readable

3. Config to replace

- `BaseUrl`
- `WorkspaceRoot`
- `ScenarioPath`
- scenario fields: `agent_model`, route config, `skill_probe`, bound role skill list

4. Command

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-workflow-e2e.ps1
```

Setup-only smoke:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-workflow-e2e.ps1 `
  -WorkspaceRoot "D:\AgentWorkSpace\TestTeam\TestWorkflowSpace" `
  -SetupOnly
```

5. Expected result

- `run_summary.md` includes `runtime_pass=True`
- pass gate is process-first: run is `finished`, main phases are `DONE`, phase dependency order is valid, no running sessions remain
- code output validation passes (`code_output_requirements` in scenario)
- reminder/skill probes are telemetry-only (non-blocking) and still exported in artifacts
- timeline and task-runtime terminal states are consistent

6. Common failure points

- skill import path invalid or bound role mismatch
- provider setup missing so sessions cannot start

### Multi Baseline (`run-multi-e2e.ps1`)

1. Purpose

- Run `chain + discuss + workflow` in one command.

2. Prerequisites

- all baseline prerequisites are satisfied

3. Config to replace

- `BaseUrl`
- each case workspace root
- optional `Cases` selection

4. Command

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-multi-e2e.ps1
```

5. Expected result

- all selected cases show `[done]`
- any case failure returns non-zero for the whole run

6. Common failure points

- one case has provider/path issue and fails aggregate run

## Default Scenarios

- `E2ETest/scenarios/a-self-decompose-chain.json`
- `E2ETest/scenarios/team-discuss-framework.json`
- `E2ETest/scenarios/workflow-gesture-real-agent.json`

Scenario files include probe metadata:

- `reminder_probe`
- `skill_probe` (workflow)

## Artifacts

Project baselines:

- `<workspace>\docs\e2e\<timestamp>\`

Workflow baseline:

- `<workspace>\docs\e2e\<timestamp>-workflow-observer\`

Common outputs:

- `run_summary.md`
- `events.ndjson` or `workflow_events.jsonl`
- `task_tree_final.json` or `workflow_task_tree_runtime.json`
- `sessions_final.json` or `workflow_sessions.json`
- `reminder_probe.json` or `workflow_reminder_probe.json`

Workflow extra outputs:

- `workflow_skill_import.json`
- `workflow_skill_validation.json`
- `workflow_artifact_validation.json`
- `workflow_phase_validation.json`
- `workflow_process_validation.json`
- `workflow_subtask_dependency_validation.json`
- `workflow_code_output_validation.json`
- `workflow_agent_subtask_stats.json`
