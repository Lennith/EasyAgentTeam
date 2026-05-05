# Release QA Report 20260505

## 2026-05-05 11:39:00 +08:00

- Check time: `2026-05-05 11:39:00 +08:00`
- Target branch: `main`
- Target commit: `b0819035673b7ed79d3ae30ad52e69761f568e6f`

### Unit Test

- Command: `pnpm test`
- Result: `PASS`
- Summary: root smoke checks passed and server unit suite passed with `481` tests, `0` failures

### README Command Check

- `pnpm i`: `PASS`
- `pnpm dev`: `PASS`
  - Verified server health at `http://127.0.0.1:43123/healthz`
- `pnpm build`: `PASS`
- `pnpm test`: `PASS`
  - Summary: root smoke checks passed and server unit suite passed with `481` tests, `0` failures

### e2e:first-run 5-Minute Stability

- Command: `pnpm e2e:first-run`
- Result: `PASS`
- Conclusion: `runtime_pass=True`, `analysis_pass=True`, `final_reason=setup_only`
- Note: the command emitted first-run artifacts under `D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260505_103726`; that workspace was later reset by the required full baseline chain case.

### Full E2E Baseline

- Command: `pnpm e2e:baseline`
- Run mode: detached independent process
- Result: `PASS`
- Chain artifacts: `D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260505_104519`
- Discuss artifacts: `D:\AgentWorkSpace\TestTeam\TestTeamDiscuss\docs\e2e\20260505_105541`
- Workflow artifacts: `D:\AgentWorkSpace\TestTeam\TestWorkflowSpace\docs\e2e\20260505_113038-workflow-observer`
- Multi-case metrics: `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\e2e\multi\20260505_113039`
- Conclusions:
  - `chain`: `runtime_pass=True`, `analysis_pass=True`, `final_reason=closed_loop`
  - `discuss`: `runtime_pass=True`, `analysis_pass=True`, `final_reason=closed_loop`
  - `workflow`: `runtime_pass=True`, `review_required=False`, `final_reason=workflow_runtime_ok`

### Blocker Check

- Conclusion: no unresolved blocking issue found during release gate
- Manual Agent result check: completed after `e2e:baseline` exit
- Manual check evidence:
  - workflow `review_required=False`
  - workflow `toolcall_failed_count=0`
  - multi-case `total_toolcall_failed_count=0`
  - provider session audit passed for all selected cases
  - provider activity audit passed for all selected cases

### Final Decision

- `PASS`

### Evidence Paths

- `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\.release-gate\20260505_103646\pnpm-dev.stdout.log`
- `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\.release-gate\20260505_103646\pnpm-dev.stderr.log`
- `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\.release-gate\20260505_103744\pnpm-e2e-baseline.stdout.log`
- `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\.release-gate\20260505_103744\pnpm-e2e-baseline.stderr.log`
- `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\release_evidence\20260505_113039\step4_manual_agent_result_check.md`
- `D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260505_104519`
- `D:\AgentWorkSpace\TestTeam\TestTeamDiscuss\docs\e2e\20260505_105541`
- `D:\AgentWorkSpace\TestTeam\TestWorkflowSpace\docs\e2e\20260505_113038-workflow-observer`
- `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\e2e\multi\20260505_113039`
