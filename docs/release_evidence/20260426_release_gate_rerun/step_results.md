# Release Gate Step Results (2026-04-26)

- check_time: 2026-04-26 19:33:41 +08:00
- target_branch: main
- tested_commit: e16b4c87aa6bc430f580b1c1c1669b9d9fdbad10

## Step 1

- command: `pnpm test`
- result: PASS

## Step 2

- command: `pnpm i`
- result: PASS
- command: `pnpm build`
- result: PASS
- command: `pnpm test:api` (README `pnpm dev` runnability check)
- result: PASS
- command: `pnpm e2e:first-run`
- result: PASS

## Step 3

- command: `pnpm e2e:baseline` (detached process)
- result: PASS
- summary: chain/discuss/workflow all passed

## Step 4

- manual agent result check: PASS
- checked:
  - chain run summary (`pass_runtime=True`, `pass_analysis=True`)
  - discuss run summary (`pass_runtime=True`, `pass_analysis=True`)
  - workflow run summary (`runtime_pass=True`, `run_finished_pass=True`, `review_required=True`)

## Key Evidence Paths

- `docs/release_evidence/20260426_173924_baseline_detached/e2e_baseline.stdout.log`
- `docs/e2e/multi/20260426_182806/stability_metrics_all.md`
- `D:/AgentWorkSpace/TestTeam/TestRound20/docs/e2e/20260426_174736/run_summary.md`
- `D:/AgentWorkSpace/TestTeam/TestTeamDiscuss/docs/e2e/20260426_175856/run_summary.md`
- `D:/AgentWorkSpace/TestTeam/TestWorkflowSpace/docs/e2e/20260426_182805-workflow-observer/run_summary.md`
