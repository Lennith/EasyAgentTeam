# Release QA Report - 2026-04-02

## Run Entry 1

- Check time: 2026-04-03 00:58:31 +08:00
- Target branch: `main`
- Commit: `8fb13beb3f4a60e36995303f369ec0be538d44cc` (`8fb13be`)

### Step 1 - Unit Tests

- Command: `pnpm test`
- Result: PASS
- Summary: tests=313, pass=308, fail=0, skipped=5

### Step 2 - README Command Runnability + First-Run Baseline

- `pnpm i`: PASS
- `pnpm dev`: PASS (startup probe succeeded; server and web both started)
- `pnpm build`: PASS
- `pnpm test`: PASS
- `pnpm e2e:first-run`: PASS (command exit code 0)

### Step 3 - Full E2E Baseline (Detached Process)

- Command: `pnpm e2e:baseline`
- Mode: detached independent process
- Result: PASS
- Case results:
  - `[done] case=chain` (`final_reason=closed_loop`)
  - `[done] case=discuss` (`final_reason=closed_loop`)
  - `[done] case=workflow` (`final_reason=workflow_runtime_ok`)
  - `== Multi E2E Passed ==`

### Step 4 - Manual Agent Result Check

- Completed after baseline exit.
- Chain summary check: PASS (`pass_runtime=True`, `pass_analysis=True`)
- Discuss summary + analysis check: PASS (`pass_runtime=True`, `pass_analysis=True`, `overall_pass=True`)
- Workflow summary check: PASS (`runtime_pass=True`, `process_validation_pass=True`, `run_finished_pass=True`, `review_required=False`)

### Blocker Check Conclusion

- No unresolved blocking issue.

### Final Decision

- **PASS**

### Evidence Paths

- Baseline launch/output log:
  - `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\logs\e2e_baseline_20260402_233849.out.log`
  - `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\logs\e2e_baseline_20260402_233849.err.log`
- Multi-E2E metrics directory:
  - `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\e2e\multi\20260403_005831`
- Chain artifacts:
  - `D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260402_234533`
- Discuss artifacts:
  - `D:\AgentWorkSpace\TestTeam\TestTeamDiscuss\docs\e2e\20260402_235524`
- Workflow artifacts:
  - `D:\AgentWorkSpace\TestTeam\TestWorkflowSpace\docs\e2e\20260403_005831-workflow-observer`
