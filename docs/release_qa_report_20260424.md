# Release QA Report 2026-04-24

## 2026-04-24 00:47 CST

- Target branch: `main`
- Tested code snapshot root commit: `d68ffa5d65748f76ba7c4fe3c785a069a9c322f6`
- Release version note: the tested snapshot includes the current local worktree changes for recovery read path scalability and workflow launch hygiene on top of `d68ffa5d65748f76ba7c4fe3c785a069a9c322f6`; the final release commit after this gate only packages this tested snapshot plus QA docs/evidence and does not change runtime behavior after gate.

### Step 1. Full Unit Test Regression

- Command: `pnpm test`
- Result: `PASS`
- Parsed outcome: `452` passed, `0` failed, duration `472154.2217ms`

Evidence:

- `docs/release_evidence/20260423_225531/step1_pnpm_test_summary.md`
- `docs/release_evidence/20260423_225531/release_gate_summary.md`

### Step 2. README Command Check And 5-Minute Baseline

- `pnpm i`: `PASS`
- `pnpm dev`: `PASS` via 20-second smoke start and clean stop
- `pnpm build`: `PASS`
- `pnpm test`: `PASS` via Step 1 full root run
- `pnpm e2e:first-run`: `PASS`

Command evidence:

- `docs/release_evidence/20260423_225531/release_gate_summary.md`
- `docs/release_evidence/20260423_225531/step2_pnpm_i.log`
- `docs/release_evidence/20260423_225531/step2_pnpm_build.log`
- `docs/release_evidence/20260423_225531/step2_pnpm_dev.stdout.log`
- `docs/release_evidence/20260423_225531/step2_pnpm_dev.stderr.log`
- `docs/release_evidence/20260423_225531/step2_pnpm_e2e_first_run.log`

### Step 3. Full E2E Baseline

- Command: `pnpm e2e:baseline`
- Result: `PASS`
- Run mode: detached independent process, exited naturally

Baseline evidence:

- `docs/release_evidence/20260423_225531/release_gate_summary.md`
- `docs/release_evidence/20260423_225531/step3_launch.json`
- `docs/release_evidence/20260423_225531/step3_pnpm_e2e_baseline.stdout.log`
- `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260423_230441/run_summary.md`
- `D:/AgentWorkSpace/TestTeam/TestTeamDiscuss/docs/e2e/20260423_232201/run_summary.md`
- `D:/AgentWorkSpace/TestTeam/TestWorkflowSpace/docs/e2e/20260424_000453-workflow-observer/run_summary.md`

### Step 4. Manual Agent Result Check

- Result: `PASS`
- Checked evidence:
  - `chain` final reason is `closed_loop`, `pass_runtime=True`, `pass_analysis=True`, `provider_session_audit_pass=True`, and `provider_activity_pass=True` in `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260423_230441/run_summary.md`
  - `discuss` final reason is `closed_loop`, `pass_runtime=True`, `pass_analysis=True`, `provider_session_audit_pass=True`, and `provider_activity_pass=True` in `D:/AgentWorkSpace/TestTeam/TestTeamDiscuss/docs/e2e/20260423_232201/run_summary.md`
  - `workflow` final reason is `workflow_runtime_ok`, `runtime_pass=True`, `process_validation_pass=True`, `artifact_validation_pass=True`, `code_output_validation_pass=True`, `subtask_stats_overall_pass=True`, `official_telemetry_pass=True`, `provider_session_audit_pass=True`, and `provider_activity_pass=True` in `D:/AgentWorkSpace/TestTeam/TestWorkflowSpace/docs/e2e/20260424_000453-workflow-observer/run_summary.md`
  - `workflow` `review_required=True` was satisfied by manual review of `workflow_process_validation.json`, `workflow_artifact_validation.json`, `workflow_code_output_validation.json`, and `warnings.json`; only slow API warnings were present and no blocker was found

Evidence:

- `docs/release_evidence/20260423_225531/step4_manual_agent_check.md`

### Blocker Check

- No unresolved blocking issue found in unit tests, README command checks, `e2e:first-run`, full E2E baseline, or Step 4 manual Agent result check.

### Final Decision

- `PASS`
