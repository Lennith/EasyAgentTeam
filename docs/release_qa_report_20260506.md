# Release QA Report 2026-05-06

## Scope

- Change: task assignment route enforcement for project and workflow runtimes.
- Product rule: `task_assign_route_table` controls `TASK_CREATE` / `TASK_ASSIGN`; `route_table` controls message/discuss routing only.
- Self-assignment remains allowed only when explicitly listed in `task_assign_route_table`; missing or empty task assign table keeps compatibility.

## Implementation Checks

- Subagent review: passed with no P0/P1 findings.
- P2 review findings were fixed:
  - project task assignment denial guidance now points to `task_assign_route_table`.
  - workflow prompt now scopes explicit self-edge guidance to configured `task_assign_route_table`.

## Command Gate

- `pnpm test`: PASS, 507 tests.
- `pnpm i`: PASS.
- `pnpm dev`: PASS, verified web `http://127.0.0.1:54174` and server `http://127.0.0.1:43123/healthz`.
- `pnpm build`: PASS.
- `pnpm test`: PASS, 507 tests.
- `pnpm docs:check`: PASS.
- `pnpm e2e:first-run`: PASS.
- `pnpm e2e:baseline`: PASS, exit code 0.

## E2E Evidence

- Baseline log: `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\.release-gate\e2e-baseline-20260506-205741\stdout.log`
- Chain artifacts: `D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260506_210725`
  - `final_reason=closed_loop`
  - `runtime_pass=True`
  - `analysis_pass=True`
- Discuss artifacts: `D:\AgentWorkSpace\TestTeam\TestTeamDiscuss\docs\e2e\20260506_211933`
  - `final_reason=closed_loop`
  - `runtime_pass=True`
  - `analysis_pass=True`
- Workflow artifacts: `D:\AgentWorkSpace\TestTeam\TestWorkflowSpace\docs\e2e\20260506_215815-workflow-observer`
  - `final_reason=workflow_runtime_ok`
  - `runtime_pass=True`
  - `workflow_run_status.status=finished`
  - all main workflow phases `DONE`
  - `workflow_agent_subtask_stats.overall_pass=true`
  - `workflow_agent_subtask_stats.allowed_creator_roles_pass=true`
  - `workflow_artifact_validation.failed=0`
  - `workflow_code_output_validation.failed=0`
  - `workflow_subtask_dependency_validation.violation_count=0`
  - `stability_metrics.toolcall_failed_count=0`

## Result

Release QA gate passed for the task assignment route enforcement change.
