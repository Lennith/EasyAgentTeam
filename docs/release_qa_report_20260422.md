# Release QA Report 2026-04-22

## 2026-04-22 07:13 CST

- Target branch: `main`
- Tested commit: `00c528fe632b769b8be27ef99683299660d51e5a`

### Step 1. Full Unit Test Regression

- Command: `pnpm test`
- Result: `PASS`

Evidence:

- `docs/release_evidence/20260422_000752/release_gate_summary.md`

### Step 2. README Command Check And 5-Minute Baseline

- `pnpm i`: `PASS`
- `pnpm dev`: `PASS`
- `pnpm build`: `PASS`
- `pnpm test`: `PASS`
- `pnpm e2e:first-run`: `PASS`

Command evidence:

- `docs/release_evidence/20260422_000752/release_gate_summary.md`
- `e2e:first-run` summary: `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260422_002610/run_summary.md`

### Step 3. Full E2E Baseline

- Command: `pnpm e2e:baseline`
- Result: `PASS`

Baseline evidence:

- `docs/release_evidence/20260422_000752/release_gate_summary.md`
- `docs/release_evidence/20260422_000752/step3_pnpm_e2e_baseline.process.json`
- `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260422_003728/run_summary.md`
- `D:/AgentWorkSpace/TestTeam/TestTeamDiscuss/docs/e2e/20260422_005032/run_summary.md`
- `D:/AgentWorkSpace/TestTeam/TestWorkflowSpace/docs/e2e/20260422_013542-workflow-observer/run_summary.md`

### Step 4. Manual Agent Result Check

- Result: `PASS`
- Checked evidence:
  - `chain` final reason is `closed_loop`, `pass_runtime=True`, `pass_analysis=True`, `provider_session_audit_pass=True`, and `provider_activity_pass=True` in `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260422_003728/run_summary.md`
  - `discuss` final reason is `closed_loop`, `pass_runtime=True`, `pass_analysis=True`, `provider_session_audit_pass=True`, and `provider_activity_pass=True` in `D:/AgentWorkSpace/TestTeam/TestTeamDiscuss/docs/e2e/20260422_005032/run_summary.md`
  - `workflow` final reason is `workflow_runtime_ok`, `runtime_pass=True`, `official_telemetry_pass=True`, `subtask_stats_overall_pass=True`, `provider_session_audit_pass=True`, and `provider_activity_pass=True` in `D:/AgentWorkSpace/TestTeam/TestWorkflowSpace/docs/e2e/20260422_013542-workflow-observer/run_summary.md`

### Blocker Check

- No unresolved blocking issue found in unit tests, README command checks, `e2e:first-run`, full E2E baseline, or Step 4 manual Agent result check.

### Final Decision

- `PASS`
