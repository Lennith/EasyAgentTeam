# E2E Baseline Regression

This folder contains the primary end-to-end regression baselines for AutoDev orchestration.

## Scope

The supported baseline scenarios are only:

- `E2ETest/scripts/run-standard-e2e.ps1`
- `E2ETest/scripts/run-discuss-e2e.ps1`
- `E2ETest/scripts/run-workflow-e2e.ps1`

E2E coverage is scenario-first:

- reminder is validated inside all 3 baseline scenarios
- skill import and actual skill use are validated inside the workflow baseline
- mechanism-only reminder/skill scripts are not part of the baseline suite

## Baselines

### Standard

`run-standard-e2e.ps1` validates a seeded dependency chain project.

Coverage:

- manager-seeded dependency structure `A -> B -> B1` and `C depends on B`
- pre-gate dispatch rejection before dependencies are open
- embedded reminder probe for the designated blocked role
- end-to-end project closure

### Discuss

`run-discuss-e2e.ps1` validates multi-agent architecture convergence.

Coverage:

- lead + 3 architect task graph
- invalid parent-dependency negative probe
- discuss traffic and convergence
- embedded reminder probe for the designated blocked role
- end-to-end project closure

### Workflow

`run-workflow-e2e.ps1` validates workflow-mode orchestration.

Coverage:

- template -> run -> session registration -> orchestrator execution
- autonomous subtask creation by non-manager roles
- embedded reminder probe for the designated workflow role
- skill fixture import through `/api/skills/import`
- skill-list binding on the configured agent role
- runtime `requestedSkillIds` evidence
- artifact marker produced by the imported skill instructions

## Scenarios

Default scenario files:

- `E2ETest/scenarios/a-self-decompose-chain.json`
- `E2ETest/scenarios/team-discuss-framework.json`
- `E2ETest/scenarios/workflow-gesture-real-agent.json`

The scenario files carry embedded probe metadata:

- `reminder_probe`
- `skill_probe` for workflow only

## Quick Start

Run one baseline:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-standard-e2e.ps1
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-discuss-e2e.ps1
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-workflow-e2e.ps1
```

Run the default baseline suite:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-multi-e2e.ps1
```

Workflow setup-only smoke:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-workflow-e2e.ps1 `
  -WorkspaceRoot "D:\AgentWorkSpace\TestTeam\TestWorkflowSpace" `
  -SetupOnly
```

Before each run, the script fully resets the selected workspace directory and rebuilds the scenario from scratch.

Default workspaces:

- `D:\AgentWorkSpace\TestTeam\TestRound20`
- `D:\AgentWorkSpace\TestTeam\TestTeamDiscuss`
- `D:\AgentWorkSpace\TestTeam\TestWorkflowSpace`

## Multi Run

`run-multi-e2e.ps1` defaults to:

- `chain`
- `discuss`
- `workflow`

Example:

```powershell
PowerShell -ExecutionPolicy Bypass -File .\E2ETest\scripts\run-multi-e2e.ps1 `
  -Cases @("chain","discuss","workflow") `
  -ChainWorkspaceRoot "D:\AgentWorkSpace\TestTeam\TestRound20" `
  -DiscussWorkspaceRoot "D:\AgentWorkSpace\TestTeam\TestTeamDiscuss" `
  -WorkflowWorkspaceRoot "D:\AgentWorkSpace\TestTeam\TestWorkflowSpace"
```

## Artifacts

Project baselines write artifacts to:

- `<workspace>\docs\e2e\<timestamp>\`

Workflow baseline writes artifacts to:

- `<workspace>\docs\e2e\<timestamp>-workflow-observer\`

Common outputs include:

- `run_summary.md`
- `events.ndjson` or `workflow_events.jsonl`
- `task_tree_final.json` or `workflow_task_tree_runtime.json`
- `sessions_final.json` or `workflow_sessions.json`
- `analysis.md` for project baselines
- `reminder_probe.json` or `workflow_reminder_probe.json`

Workflow-specific outputs also include:

- `workflow_skill_import.json`
- `workflow_skill_validation.json`
- `workflow_artifact_validation.json`
- `workflow_phase_validation.json`
- `workflow_agent_subtask_stats.json`

## Baseline Pass Rules

### Standard / Discuss

- seeded task graph is correct
- dependency gate checks reject blocked work before release
- reminder probe shows `trigger -> message redispatch -> later progress`
- scenario reaches normal closed-loop completion
- no unresolved execution tasks remain
- no sessions remain running at finish

### Workflow

- workflow reaches terminal success with all phase tasks done
- reminder probe shows `trigger -> message redispatch -> later progress`
- non-manager subtask creation thresholds pass
- required artifacts exist and contain expected keywords
- imported skill is injected at runtime for the configured role
- imported skill marker appears in the designated artifact
