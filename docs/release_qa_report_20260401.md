# Release QA Report - 2026-04-01

## Run Entry 1

- Check time: 2026-04-01 17:29:53 +08:00
- Target branch: `codex/v3-refactor`
- Commit: `cb305c4d16a8eef2f21ece4b2d82c1c691fddfa3`

### Step 1 - Unit Tests

- Command: `pnpm test`
- Result: PASS
- Summary: tests=313, pass=308, fail=0, skipped=5

### Step 2 - README Command Runnability + First-Run Baseline

- `pnpm i`: PASS
- `pnpm dev`: PASS (startup probe succeeded after clearing stale local port-occupying process)
- `pnpm build`: PASS
- `pnpm test`: PASS
- `pnpm e2e:first-run`: PASS

`e2e:first-run` summary:

- `runtime_pass=True`
- `analysis_pass=True`
- `final_reason=setup_only`

### Step 3 - Full E2E Baseline (Detached Process)

- Command: `pnpm e2e:baseline`
- Mode: detached independent process
- Result: FAIL (workflow case timeout / external provider instability)
- Failure marker:
  - `[failed] case=workflow exitCode=2`
  - `final_reason=timeout`
  - `runtime_pass=False`
  - `review_required=True`

### Step 4 - Manual Agent Result Check

- Completed after baseline exit.
- Findings:
  - Server health endpoint normal.
  - Project/workflow orchestrator internal contract tests and service tests are green in unit suite.
  - Failure concentrated on external MiniMax provider instability (`overloaded_error` / 5xx bursts) during workflow E2E runtime window.

### Blocker Check Conclusion

- Blocking issue exists for strict full-gate PASS:
  - External provider instability (MiniMax) caused repeated dispatch timeout/failure loops in workflow E2E.
- Internal code-path confidence remains high:
  - `pnpm --filter @autodev/server build`: PASS
  - `pnpm --filter @autodev/server test`: PASS

### Waiver Record

- Approver statement (requester): `没啥用，我试了，我另外个项目minimax也被限制了。这轮我们认为收敛了。外部原因导致无法推进。`
- Unfinished scope:
  - Step 3 full E2E workflow case cannot be marked passed due external provider outage/instability.
- Decision: **PASS by waiver**

### Evidence Paths

- Baseline launch/output log:
  - `docs/release_logs/e2e_baseline_20260401_144035.out.log`
  - `docs/release_logs/e2e_baseline_20260401_144035.err.log`
- Multi-E2E metrics directory:
  - `docs/e2e/multi/20260401_161243`
- First-run artifacts:
  - `D:\AgentWorkSpace\TestTeam\TestRound20\docs\e2e\20260401_143953`
- Workflow runtime evidence:
  - `data/workflows/runs/e2e_gesture_run_20260401144037/events.jsonl`
  - `data/workflows/runs/e2e_gesture_run_20260401144037/role_reminders.json`
  - `data/workflows/runs/e2e_gesture_run_20260401144037/sessions.json`
