# Release QA Report - 2026-04-27

## Run 1

- Check time: 2026-04-27 07:31:37 +08:00
- Target branch: `main`
- Tested commit: `9e18a41040347fa39a5a9173c17ec7cc096ad6fe`

### Step 1 - Unit Test Regression

- Command: `pnpm test`
- Result: PASS

### Step 2 - README Command Runnability + First-Run Baseline

- `pnpm i`: PASS
- `pnpm build`: PASS
- `pnpm test:api` (README `pnpm dev` runnability check): PASS
- `pnpm e2e:first-run`: PASS

### Step 3 - Full E2E Baseline (Detached)

- Command: `pnpm e2e:baseline`
- Result: PASS
- Case summary: `chain=PASS`, `discuss=PASS`, `workflow=PASS`

### Step 4 - Manual Agent Result Check

- Result: PASS
- Checked summaries:
  - chain: `pass_runtime=True`, `pass_analysis=True`
  - discuss: `pass_runtime=True`, `pass_analysis=True`
  - workflow: `runtime_pass=True`, `run_finished_pass=True`, `process_validation_pass=True`, `review_required=True` (manually reviewed)

### Blocker Check

- Unresolved blocker: NONE

### Final Decision

- `PASS`

### Evidence Paths

- `docs/release_evidence/20260427_000257_baseline_detached/e2e_baseline.stdout.log`
- `docs/release_evidence/20260427_000257_baseline_detached/e2e_baseline.stderr.log`
- `docs/e2e/multi/20260427_010444/stability_metrics_all.md`
- `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260427_001032/run_summary.md`
- `D:/AgentWorkSpace/TestTeam/TestTeamDiscuss/docs/e2e/20260427_002424/run_summary.md`
- `D:/AgentWorkSpace/TestTeam/TestWorkflowSpace/docs/e2e/20260427_010443-workflow-observer/run_summary.md`
- `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260427_000236/run_summary.md`
