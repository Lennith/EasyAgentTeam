# Release Gate Summary

- check_time: 2026-04-23 15:50 CST
- target_branch: main
- tested_code_snapshot_root_commit: 0aed765754be7f7d4c19db7dc5f4a4876f63fcea
- release_note: tested snapshot includes the current recovery read model scalability and workflow runtime mutation hygiene worktree changes; final release commit will only package this tested snapshot plus QA docs/evidence and does not change runtime behavior after gate.

## Step 1. Full Unit Test Regression

- command: `pnpm test`
- result: PASS
- log: `docs/release_evidence/20260423_140017/step1_pnpm_test.log`

## Step 2. README Command Check And 5-Minute Baseline

- `pnpm i`: PASS
  - log: `docs/release_evidence/20260423_140017/step2_pnpm_i.log`
- `pnpm dev`: PASS
  - verification: `pnpm test:api` internally launches `pnpm dev`, waits for `/healthz` and dashboard proxy, then tears it down
  - log: `docs/release_evidence/20260423_140017/step2_pnpm_dev_via_test_api.log`
- `pnpm build`: PASS
  - log: `docs/release_evidence/20260423_140017/step2_pnpm_build.log`
- `pnpm test`: PASS
  - log: `docs/release_evidence/20260423_140017/step2_pnpm_test.log`
- `pnpm e2e:first-run`: PASS
  - log: `docs/release_evidence/20260423_140017/step2_pnpm_e2e_first_run.log`
  - note: the setup-only external workspace artifact directory was later cleaned by Step 3 baseline workspace reset; repo-local first-run log retains the PASS summary and exported artifact path emitted at runtime.

## Step 3. Full E2E Baseline

- command: `pnpm e2e:baseline`
- result: PASS
- process: `docs/release_evidence/20260423_140017/step3_pnpm_e2e_baseline.process.json`
- exitcode: `docs/release_evidence/20260423_140017/step3_pnpm_e2e_baseline.exitcode.txt`
- finished_at: `docs/release_evidence/20260423_140017/step3_pnpm_e2e_baseline.finished_at.txt`
- chain summary: `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260423_141803/run_summary.md`
- discuss summary: `D:/AgentWorkSpace/TestTeam/TestTeamDiscuss/docs/e2e/20260423_143501/run_summary.md`
- workflow summary: `D:/AgentWorkSpace/TestTeam/TestWorkflowSpace/docs/e2e/20260423_154308-workflow-observer/run_summary.md`

## Step 4. Manual Agent Result Check

- result: PASS
- evidence: `docs/release_evidence/20260423_140017/step4_manual_agent_result_check.md`

## Blocker Check

- No unresolved blocking issue found in Step 1, Step 2, Step 3, or Step 4.

## Final Decision

- PASS
