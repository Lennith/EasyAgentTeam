# Release QA Report - 2026-03-27

## Release Gate Run - 2026-03-27 09:58:00 +08:00

- Check time: 2026-03-27 09:58:00 +08:00
- Target branch: `main`
- Target commit: `8c7ffaced7b271c3c9944ee4ebfb0b26a62ed0ad`

### 1. Unit test regression

- Command: `pnpm test`
- Result: PASS

### 2. README command runnability + first-run baseline

- `pnpm i`: PASS
- `pnpm dev` (start and runnable check via `node tools/verify_dev.mjs`): PASS
- `pnpm build`: PASS
- `pnpm test`: PASS
- `pnpm e2e:first-run`: PASS
- `e2e:first-run` artifacts: `D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260327_081622-precheck`

### 3. Full E2E baseline (detached)

- Command: `pnpm e2e:baseline`
- Run mode: detached/background process
- Result: PASS
- Evidence:
  - baseline log: `docs/release_logs/20260327_081617/e2e_baseline.out.log`
  - chain artifacts: `D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260327_082220`
  - discuss artifacts: `D:\AgentWorkSpace\TestTeam\TestTeamDiscuss\docs\e2e\20260327_082629`
  - workflow artifacts: `D:\AgentWorkSpace\TestTeam\TestWorkflowSpace\docs\e2e\20260327_084605-workflow-observer`
  - multi metrics: `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\e2e\multi\20260327_084605`

### 4. Manual agent result check (post baseline exit)

- Baseline process state: exited
- Log checks:
  - `[done] case=chain`
  - `[done] case=discuss`
  - `[done] case=workflow`
  - `== Multi E2E Passed ==`
- Artifact path existence check: PASS (all 3 case directories + multi metrics directory exist)

### Blocker check

- No unresolved blocking issue found.

### Final decision

- PASS

## Release Gate Run - 2026-03-27 12:12:27 +08:00

- Check time: 2026-03-27 12:12:27 +08:00
- Target branch: `main`
- Target commit: `8c7ffaced7b271c3c9944ee4ebfb0b26a62ed0ad`

### 1. Unit test regression

- Command: `pnpm test`
- Result: PASS

### 2. README command runnability + first-run baseline

- `pnpm i`: PASS
- `pnpm dev` (start and runnable check via `node tools/verify_dev.mjs`): PASS
- `pnpm build`: PASS
- `pnpm test`: PASS
- `pnpm e2e:first-run`: PASS
- `e2e:first-run` artifacts: `D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260327_111439-precheck`

### 3. Full E2E baseline (detached)

- Command: `pnpm e2e:baseline`
- Run mode: detached/background process
- Result: PASS
- Evidence:
  - baseline stdout: `docs/release_logs/20260327_111434_baseline/e2e_baseline.out.log`
  - baseline stderr: `docs/release_logs/20260327_111434_baseline/e2e_baseline.err.log`
  - chain artifacts: `D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260327_112748`
  - discuss artifacts: `D:\AgentWorkSpace\TestTeam\TestTeamDiscuss\docs\e2e\20260327_114213`
  - workflow artifacts: `D:\AgentWorkSpace\TestTeam\TestWorkflowSpace\docs\e2e\20260327_114957-workflow-observer`
  - multi metrics: `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\e2e\multi\20260327_114957`

### 4. Manual agent result check (post baseline exit)

- Baseline process state: exited
- Log checks:
  - `[done] case=chain`
  - `[done] case=discuss`
  - `[done] case=workflow`
  - `== Multi E2E Passed ==`
- Artifact path existence check: PASS (all paths validated)

### Blocker check

- No unresolved blocking issue found.

### Final decision

- PASS
