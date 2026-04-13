# E2E Baseline Regression

This folder is the official scenario entry for orchestration validation, not an auxiliary test set.

## Scope

Supported baseline scripts:

- `E2ETest/scripts/run-standard-e2e.ps1`
- `E2ETest/scripts/run-discuss-e2e.ps1`
- `E2ETest/scripts/run-workflow-e2e.ps1`
- `E2ETest/scripts/run-template-agent-e2e.ps1`

Coverage is scenario-first:

- reminder behavior is validated inside all three baselines
- skill import and runtime skill usage are validated inside workflow baseline
- mechanism-only scripts are intentionally excluded from baseline entry
- no standalone reminder-only or skill-import-only official E2E entry is maintained
- all three baseline scripts accept `-ProviderId minimax|codex` as a diagnostic force-override
- baseline default is mixed-provider `agent_model_matrix`
- each baseline case must exercise both `codex` and `minimax`
- `pnpm e2e:baseline` is the formal mixed baseline entry; `pnpm e2e:codex-parity` remains a diagnostic all-Codex override

## What Each E2E Validates

- `standard`: project dependency-chain orchestration and close-loop completion
- `discuss`: multi-agent architecture discussion and convergence flow
- `workflow`: workflow template/run/session orchestration plus skill injection evidence
- `template-agent`: static TemplateAgent workspace fixture publish flow (`workflow + project` two-case serial run)
- `multi`: aggregate launcher for the official mixed baseline `standard + discuss + workflow`

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
- provider setup is available (default scenario uses mixed-provider `agent_model_matrix`)

3. Config to replace

- `BaseUrl`
- `WorkspaceRoot`
- `ScenarioPath` (if using custom scenario)
- scenario fields: `agent_model_matrix`, `route_table`, `task_assign_route_table`, `route_discuss_rounds`

4. Command

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-standard-e2e.ps1
```

Forced single-provider diagnostic:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-standard-e2e.ps1 -ProviderId codex
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
- scenario fields: `agent_model_matrix`, discuss routing, and round policy

4. Command

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-discuss-e2e.ps1
```

Forced single-provider diagnostic:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-discuss-e2e.ps1 -ProviderId codex
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
- scenario fields: `agent_model_matrix`, route config, `skill_probe`, bound role skill list

4. Command

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-workflow-e2e.ps1
```

Forced single-provider diagnostic:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-workflow-e2e.ps1 -ProviderId codex
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
- official mixed baseline also expects workflow telemetry to stay green:
  - `artifact_validation_pass=True`
  - `subtask_stats_overall_pass=True`
  - `skill_probe_pass=True`
  - `provider_session_audit_pass=True`
  - `provider_activity_pass=True`
- workflow script should exit non-zero when the official mixed-baseline telemetry set above is `False`
- reminder probe remains a telemetry export; a `False` reminder result still requires investigation but does not by itself fail the workflow case
- timeline and task-runtime terminal states are consistent

6. Common failure points

- skill import path invalid or bound role mismatch
- provider setup missing so sessions cannot start

### Multi Baseline (`run-multi-e2e.ps1`)

1. Purpose

- Run the official mixed baseline `chain + discuss + workflow` in one command.

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

Forced single-provider diagnostic:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-multi-e2e.ps1 -ProviderId codex
```

5. Expected result

- all selected cases show `[done]`
- default baseline resolves both `codex` and `minimax` inside each primary case
- any case failure returns non-zero for the whole run

6. Common failure points

- one case has provider/path issue and fails aggregate run

### TemplateAgent Baseline (`run-template-agent-e2e.ps1`)

1. Purpose

- Validate static `TemplateAgentWorkspace` fixture flow end-to-end:
  - workflow case: `check -> publish -> start run -> finish`
  - project case: `check -> publish -> registration verification`

2. Prerequisites

- backend is running and reachable at `BaseUrl`
- repository root contains static workspace `TemplateAgentWorkspace/`

3. Config to replace

- `BaseUrl`
- `WorkspaceRoot` (optional)
- `DataRoot` (optional, default `data/`)
- `MaxSeconds`

4. Command

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-template-agent-e2e.ps1
```

5. Expected result

- both sub-cases finish with `pass` or `pass_with_event_gap`
- artifacts output includes:
  - `template_agent_e2e_results.json|md`
  - `workflow.result.json|md`
  - `project.result.json|md`

6. Common failure points

- static workspace missing or corrupted
- publish conflict from duplicated IDs
- workflow run cannot reach terminal state in timeout

## Default Scenarios

- `E2ETest/scenarios/a-self-decompose-chain.json`
- `E2ETest/scenarios/team-discuss-framework.json`
- `E2ETest/scenarios/workflow-gesture-real-agent.json`
- `E2ETest/scenarios/workflow-external-agent-3dof.json`
- `E2ETest/scenarios/template-agent-two-case.json`

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

Template-agent outputs:

- `template_agent_e2e_results.json`
- `template_agent_e2e_results.md`
- `workflow.result.json`
- `project.result.json`

## Cleanup Script

Safe cleanup for historical template-agent test artifacts and test data:

```powershell
node .\E2ETest\scripts\cleanup-template-agent-test-data.mjs
node .\E2ETest\scripts\cleanup-template-agent-test-data.mjs --confirm
```

- default is dry-run
- cleanup scope is repo-local allowlist paths + data IDs matching configured prefixes
