# Agent Working Guide

This repository is a `pnpm` monorepo for AutoDev task-driven collaboration.

## Scope

- `agent_library/`: shared types and schemas
- `server/`: backend API and orchestration runtime
- `dashboard-v2/`: current dashboard frontend
- `TeamsTools/`: Team tool docs/templates for workspace bootstrap
- `E2ETest/`: standardized end-to-end regression scripts

## Current Baseline (V2)

- Task protocol is centered on `POST /api/projects/:id/task-actions`.
- Task query is `GET /api/projects/:id/task-tree`.
- Auto dispatch config is `auto_dispatch_enabled` + `auto_dispatch_remaining`.
- Discuss uses `TASK_DISCUSS_REQUEST|TASK_DISCUSS_REPLY|TASK_DISCUSS_CLOSED`.
- Legacy project task APIs have been removed and must not be reintroduced as compatibility stubs.

## Commands

```powershell
# install
pnpm i

# dev
pnpm dev
pnpm dev:legacy

# build
pnpm build
pnpm --filter @autodev/server build
pnpm --filter dashboard-v2 build

# docs/health
pnpm docs:check
pnpm run doctor
pnpm healthcheck

# tests
pnpm test
pnpm --filter @autodev/server test
pnpm --filter @autodev/server run test -- --test-name-pattern "task report"
```

## Engineering Rules

- Use PowerShell-compatible commands; avoid bash-only syntax.
- Use `pnpm --filter` instead of `npm --prefix`.
- Keep TypeScript strict and NodeNext-compatible import paths.
- Prefer adding/adjusting tests with backend behavior changes.
- Do not commit runtime data/log artifacts under `data/projects/**`, `.minimax/**`, `.trae/**`.

## PRD-First Change Control

For any business logic change, update the corresponding module PRD before implementation and keep PRD status markers in sync with execution:

- Before code change: update module PRD first and mark the impacted section as `改动中`.
- After code is landed: update the same PRD section to `验证中`.
- After tests pass and behavior is verified: update the PRD section to `实装`.
- PRD content rule: always overwrite the corresponding old logic with current effective logic; do not keep "delta/change log" style text inside module PRD body.

## Release Gate (上线检测)

This is a process control rule in this repository. It is not a product code feature.

- Trigger: release gate starts only when the prompt explicitly asks for `上线检测`.
- Execution order (mandatory):
  - **Step 1**: Run full unit test regression first (`pnpm test` from repo root).
  - **Step 2**: Verify README basic commands are runnable in this environment (`pnpm i`, `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm e2e:first-run`), and run `pnpm e2e:first-run` as the 5-minute stability baseline.
    - Step 2 explicitly does **not** require standalone execution of `pnpm e2e:standard`, `pnpm e2e:discuss`, or `pnpm e2e:workflow` (these are covered by Step 3 `pnpm e2e:baseline`).
  - **Step 3**: Run full E2E regression only if Step 2 passes (`pnpm e2e:baseline`) in a detached independent process (keep it running in background; do not wait for completion in the same operation).
  - **Step 4**: Manually trigger Agent result check only after requester confirms to check and `e2e:baseline` has exited.
  - Step 3 runtime rule: do not perform runtime observation/tracing while `e2e:baseline` is running, and do not terminate the process proactively.
  - Fail-fast rule: if any test case fails in any step, stop immediately and do not execute any subsequent test commands or steps.
- Pass criteria (all required):
  - Step 1 passed (full unit tests).
  - Step 2 passed (README command runnability + `e2e:first-run` 5-minute baseline).
  - Step 3 passed (full E2E baseline: chain + discuss + workflow, independent-process run mode).
  - Step 4 completed (manual Agent result check after `e2e:baseline` process exit).
  - No unresolved blocking issue in the release conclusion.
- Waiver path (exception, explicit approval required):
  - If the requester explicitly confirms a release decision based on orchestrator behavior conformance (for example: `编排器符合设计即可发版`), release may proceed before full E2E completion.
  - This waiver must be recorded in the same-day release QA report with:
    - approver statement,
    - current unfinished test scope,
    - objective evidence paths,
    - and a clear `PASS by waiver` conclusion.
- Push constraint:
  - Final push to GitHub is not allowed before release gate passes.

### Release QA Report Rule

- Write report only for versions that passed release gate.
- Report path and filename:
  - `docs/release_qa_report_YYYYMMDD.md`
- Same-day behavior:
  - If multiple release-gate runs happen on the same day, append each run result in time order to the same file.
  - Do not create a second same-day release QA report file.
- Non-release or failed release-gate runs:
  - Do not create this report file.

### Minimum Report Content

Each appended run entry must include:

- Check time
- Target branch and commit information
- Unit test command and result
- README command check list and run results
- `e2e:first-run` 5-minute stability result
- Full E2E (`e2e:baseline`) command and result
- Blocker check conclusion
- Final decision (`PASS` or `FAIL`)
- Evidence paths (key logs and artifact paths)

## E2E Design Rules

- E2E exists to cover primary product scenarios and their critical acceptance paths, not isolated internal mechanisms.
- Prefer scenario-based E2E cases that exercise complete user-visible flows in `project` or `workflow` runtime.
- Mechanism checks such as `reminder`, `redispatch`, `repair`, `timeout recovery`, and similar orchestration internals must be asserted inside the relevant primary scenario E2E. Do not add standalone E2E scripts for those mechanisms alone.
- If a mechanism needs narrow validation, prefer backend/unit/integration tests under `server/src/__tests__/` instead of creating a dedicated E2E case.
- `skill` capability may justify E2E coverage only when it is part of a full scenario: local import -> skill list binding -> agent execution actually depends on that skill -> scenario outcome validates the skill path. A pure import-or-injection smoke is not a target E2E shape.
- `run-multi-e2e` should aggregate only primary scenario cases. It must not include mechanism-only runs as default children.
- E2E scenario additions must declare which primary capability they cover and which existing scenario they cannot be absorbed into.
- When reviewing E2E scripts, remove or fold cases that only prove internal plumbing without validating a top-level workflow outcome.

## Agent Workspace Template Test Policy

- Template feature testing (`validate`/`apply` contracts, parser/checker behavior, rollback logic) may use simulated bundle generation.
- Real template verification must use a real external agent execution path for template generation; simulation is not allowed in this test type.
- If no external agent is explicitly specified, default to `subagent` as the real external agent substitute.
- Real verification evidence must include:
  - agent prompt input,
  - generated bundle path,
  - backend registration results (`validate` + `apply`),
  - workflow/project runtime observation results.
- Test data injected during template tests must be cleaned after the run unless the requester explicitly asks to preserve them.

## Fast Start for Agents

- If task is backend behavior: start in `server/src/services/` and related tests in `server/src/__tests__/`.
- If task is dashboard adaptation: start in `dashboard-v2/src/` and match `docs/designV2/frontend_dashboard_v2_backend_api_requirements.md`.
- If task is workflow/E2E: use `E2ETest/scripts/` first; avoid ad-hoc scripts.
