# Release QA Report (2026-04-06)

## 22:33 CST Gate Run

- Check time: 2026-04-06 20:50 - 22:33 (Asia/Shanghai)
- Target branch: `main`
- Target commit: `9e3f91814dd6f1a1e3a24f2629f43e5e006ba574`

### Step 1 - Unit Regression

- Command: `pnpm test`
- Result: `PASS`

### Step 2 - README Command Runnability + First-run Baseline

- `pnpm i`: `PASS`
- `pnpm dev`: first attempt failed (`EADDRINUSE 127.0.0.1:43123` from stale local dev node process), stale process cleaned, rerunability check passed
- `pnpm build`: `PASS`
- `pnpm test`: `PASS`
- `pnpm e2e:first-run`: `PASS`
- First-run 5-minute baseline verdict: `runtime_pass=True`, `analysis_pass=True`

### Step 3 - Full E2E Baseline (Independent Process)

- Command: `pnpm e2e:baseline`
- Mode: detached independent process, natural exit
- Result: `PASS` (`== Multi E2E Passed ==`)
- Case-level summary:
  - `chain`: `pass=True`, `exit_code=0`
  - `discuss`: `pass=True`, `exit_code=0`
  - `workflow`: `pass=True`, `exit_code=0`

### Step 4 - Manual Agent Result Check

- Manual check status: `COMPLETED`
- Checked artifacts:
  - chain/discuss/workflow `run_summary.md` all show terminal pass signals
  - multi metrics aggregate confirms all selected cases `final_pass=true`

### Blocker Check Conclusion

- Blocking regressions: `NONE`
- WAL EPERM timeline issue: fixed path verified by server tests and release-gate E2E run (no `agent-io/timeline` 500 blocker recurrence)
- `toolcall_failed_count`: observed but non-blocking by current gate rule (all cases `final_pass=true`)
- `dispatch_nudge`: observed in workflow as soft-gate fallback; non-blocking because final convergence reached

### Final Decision

- `PASS`

### Evidence Paths

- Step 2 first-run artifacts:
  - `D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260406_205754`
- Step 3 baseline launcher logs:
  - `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\e2e\baseline_20260406_205833.out.log`
  - `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\e2e\baseline_20260406_205833.err.log`
- Step 3 aggregate metrics:
  - `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\e2e\multi\20260406_222902\stability_metrics_all.md`
  - `C:\Users\spiri\Documents\GitHub\EasyAgentTeam\docs\e2e\multi\20260406_222902\stability_metrics_all.json`
- Step 4 case summaries:
  - `D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260406_210435\run_summary.md`
  - `D:\AgentWorkSpace\TestTeam\TestTeamDiscuss\docs\e2e\20260406_211705\run_summary.md`
  - `D:\AgentWorkSpace\TestTeam\TestWorkflowSpace\docs\e2e\20260406_222902-workflow-observer\run_summary.md`
