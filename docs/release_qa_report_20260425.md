# Release QA Report - 2026-04-25

## Run: Recovery Hot Index Convergence

- Check time: 2026-04-25T09:40:00+08:00
- Target branch: `main`
- Target HEAD: `dad92f8988371cee6b07ea36ee8ecccd5d66191d`
- Tested source: local worktree snapshot on top of target HEAD
- Evidence root: `docs/release_evidence/20260424_233654`
- Final decision: `PASS`

### Source Snapshot

The release gate tested the current local worktree snapshot containing the Recovery Hot Index Convergence changes. The Git HEAD at gate start was `dad92f8988371cee6b07ea36ee8ecccd5d66191d`; the worktree included uncommitted source, spec, test, and release-evidence changes.

### Step 1 - Unit Regression

- Command: `pnpm test`
- Result: `PASS`
- Evidence:
  - `docs/release_evidence/20260424_233654/step1_pnpm_test.json`
  - `docs/release_evidence/20260424_233654/step1_pnpm_test.log`

### Step 2 - README Command Check and First-Run Baseline

- Command: `pnpm i`
- Result: `PASS`
- Evidence: `docs/release_evidence/20260424_233654/step2_pnpm_i.json`

- Command: `pnpm build`
- Result: `PASS`
- Evidence: `docs/release_evidence/20260424_233654/step2_pnpm_build.json`

- Command: `pnpm dev`
- Result: `PASS` by smoke check; process stayed running after 20 seconds and was stopped by the smoke harness.
- Evidence: `docs/release_evidence/20260424_233654/step2_pnpm_dev_smoke.json`

- Command: `pnpm test`
- Result: `PASS`; covered by Step 1.

- Command: `pnpm e2e:first-run`
- Result: `PASS`
- Evidence:
  - `docs/release_evidence/20260424_233654/step2_pnpm_e2e_first_run.json`
  - external artifacts: `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260424_234442`

### Step 3 - Full E2E Baseline

- Command: `pnpm e2e:baseline`
- Run mode: detached independent process
- Initial attempt: failed with `chain` timeout after user-reported accidental runtime process closure.
- Rerun reason: user requested Step 3 rerun because the original runtime process was accidentally closed.
- Rerun result: `PASS`
- Final line: `== Multi E2E Passed ==`
- Evidence:
  - `docs/release_evidence/20260424_233654/step3_rerun_launch.json`
  - `docs/release_evidence/20260424_233654/step3_rerun_result.json`
  - `docs/release_evidence/20260424_233654/step3_rerun_pnpm_e2e_baseline.stdout.log`
  - multi summary: `docs/e2e/multi/20260425_090430`

Scenario results:

- `chain`: `PASS`
  - final_reason: `closed_loop`
  - runtime_pass: `True`
  - analysis_pass: `True`
  - artifacts: `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260425_080045`

- `discuss`: `PASS`
  - final_reason: `closed_loop`
  - runtime_pass: `True`
  - analysis_pass: `True`
  - artifacts: `D:/AgentWorkSpace/TestTeam/TestTeamDiscuss/docs/e2e/20260425_081842`

- `workflow`: `PASS`
  - final_reason: `workflow_runtime_ok`
  - runtime_pass: `True`
  - review_required: `True`
  - artifacts: `D:/AgentWorkSpace/TestTeam/TestWorkflowSpace/docs/e2e/20260425_090429-workflow-observer`

### Step 4 - Manual Agent Result Check

- Result: `PASS`
- Evidence: `docs/release_evidence/20260424_233654/step4_manual_agent_check.md`

Manual check conclusions:

- Chain scenario reached `closed_loop`, with no open execution tasks and no running sessions.
- Discuss scenario reached `closed_loop`, with 15 discuss routed messages, no open execution tasks, and no running sessions.
- Workflow scenario reached `workflow_runtime_ok`; process validation, run finish, phase dependency order, code output validation, artifact validation, subtask dependency validation, subtask stats, official telemetry, provider session audit, and provider activity checks all passed.
- Workflow `review_required=True` was reviewed and treated as non-blocking because the underlying warnings were slow API observations and a non-blocking reminder probe warning; no runtime, artifact, dependency, or telemetry blocker remained.

### Blocker Check

- Unresolved blockers: none
- Non-blocking recovered events:
  - total_toolcall_failed_count: `1`
  - total_timeout_recovered_count: `3`
  - mixed_provider_case_pass_count: `3`
  - provider_session_audit_pass_count: `3`
  - provider_activity_pass_count: `3`

### Final Decision

`PASS`
