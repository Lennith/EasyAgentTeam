# Release QA Report - 2026-03-19

## Release Gate Run - 2026-03-19 07:56:14 +08:00

- Check time: 2026-03-19 07:56:14 +08:00
- Target branch: $branch
- Target commit: $commit

### 1. Unit test regression

- Command: pnpm test
- Result: PASS

### 2. README command runnability + first-run baseline

- pnpm i: PASS
- pnpm dev (start and runnable check): PASS (log: docs/release_logs/20260319_003740/dev_check.out.log)
- pnpm build: PASS
- pnpm test: PASS
- pnpm e2e:first-run: PASS
- e2e:first-run artifacts: D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260319_003949

### 3. Full E2E baseline (detached)

- Command: pnpm e2e:baseline
- Run mode: detached/background process
- Result: PASS
- Evidence:
  - baseline log: docs/release_logs/20260319_003740/e2e_baseline.out.log
  - chain artifacts: D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260319_004808
  - discuss artifacts: D:\AgentWorkSpace\TestTeam\TestTeamDiscuss\docs\e2e\20260319_010036
  - workflow artifacts: D:\AgentWorkSpace\TestTeam\TestWorkflowSpace\docs\e2e\20260319_015047-workflow-observer
  - multi metrics: C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\e2e\multi\20260319_015047

### 4. Manual agent result check (post baseline exit)

- Baseline process state: exited
- Log checks:
  - [done] case=chain
  - [done] case=discuss
  - [done] case=workflow
  - == Multi E2E Passed ==
- Artifact path existence check: PASS (all 3 case directories exist)

### Blocker check

- No unresolved blocking issue found.

### Final decision

- PASS
