# Release QA Report 2026-04-23

## 2026-04-23 15:50 CST

- Target branch: `main`
- Tested code snapshot root commit: `0aed765754be7f7d4c19db7dc5f4a4876f63fcea`
- Release version note: the tested snapshot includes the current recovery read model scalability and workflow runtime mutation hygiene worktree changes; the final release commit after this gate only packages this tested snapshot plus QA docs/evidence and does not change runtime behavior after gate.

### Step 1. Full Unit Test Regression

- Command: `pnpm test`
- Result: `PASS`

Evidence:

- `docs/release_evidence/20260423_140017/release_gate_summary.md`
- `docs/release_evidence/20260423_140017/step1_pnpm_test.log`

### Step 2. README Command Check And 5-Minute Baseline

- `pnpm i`: `PASS`
- `pnpm dev`: `PASS` via `pnpm test:api` runnability check
- `pnpm build`: `PASS`
- `pnpm test`: `PASS`
- `pnpm e2e:first-run`: `PASS`

Command evidence:

- `docs/release_evidence/20260423_140017/release_gate_summary.md`
- `docs/release_evidence/20260423_140017/step2_pnpm_i.log`
- `docs/release_evidence/20260423_140017/step2_pnpm_dev_via_test_api.log`
- `docs/release_evidence/20260423_140017/step2_pnpm_build.log`
- `docs/release_evidence/20260423_140017/step2_pnpm_test.log`
- `docs/release_evidence/20260423_140017/step2_pnpm_e2e_first_run.log`
- Note: Step 3 baseline reset the external first-run workspace, so the durable first-run PASS evidence for this gate is the repo-local `step2_pnpm_e2e_first_run.log` capture.

### Step 3. Full E2E Baseline

- Command: `pnpm e2e:baseline`
- Result: `PASS`

Baseline evidence:

- `docs/release_evidence/20260423_140017/release_gate_summary.md`
- `docs/release_evidence/20260423_140017/step3_pnpm_e2e_baseline.process.json`
- `docs/release_evidence/20260423_140017/step3_pnpm_e2e_baseline.exitcode.txt`
- `docs/release_evidence/20260423_140017/step3_pnpm_e2e_baseline.finished_at.txt`
- `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260423_141803/run_summary.md`
- `D:/AgentWorkSpace/TestTeam/TestTeamDiscuss/docs/e2e/20260423_143501/run_summary.md`
- `D:/AgentWorkSpace/TestTeam/TestWorkflowSpace/docs/e2e/20260423_154308-workflow-observer/run_summary.md`

### Step 4. Manual Agent Result Check

- Result: `PASS`
- Checked evidence:
  - `chain` final reason is `closed_loop`, `pass_runtime=True`, `pass_analysis=True`, `provider_session_audit_pass=True`, and `provider_activity_pass=True` in `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260423_141803/run_summary.md`
  - `discuss` final reason is `closed_loop`, `pass_runtime=True`, `pass_analysis=True`, `provider_session_audit_pass=True`, and `provider_activity_pass=True` in `D:/AgentWorkSpace/TestTeam/TestTeamDiscuss/docs/e2e/20260423_143501/run_summary.md`
  - `workflow` final reason is `workflow_runtime_ok`, `runtime_pass=True`, `official_telemetry_pass=True`, `subtask_stats_overall_pass=True`, `provider_session_audit_pass=True`, and `provider_activity_pass=True` in `D:/AgentWorkSpace/TestTeam/TestWorkflowSpace/docs/e2e/20260423_154308-workflow-observer/run_summary.md`

### Blocker Check

- No unresolved blocking issue found in unit tests, README command checks, `e2e:first-run`, full E2E baseline, or Step 4 manual Agent result check.

### Final Decision

- `PASS`
