# EasyAgentTeam Refactor Plans

This directory tracks current refactor plans, baseline snapshots, and archived debt notes for the repository.

## Current Plans

| File                                                                                         | Status     | Purpose                                                                                                            |
| -------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| [orchestrator_shared_abstraction_20260328.md](./orchestrator_shared_abstraction_20260328.md) | Active     | Current-state plan for project/workflow orchestrator shared abstraction, known issues, and remaining work.         |
| [tech_debt_01_api_routing_refactor.md](./tech_debt_01_api_routing_refactor.md)               | Historical | Early routing refactor plan. Use current server routes and PRD state as the source of truth before implementation. |
| [tech_debt_03_storage_transaction.md](./tech_debt_03_storage_transaction.md)                 | Active     | Repository and UnitOfWork expansion plan for storage/runtime boundaries.                                           |
| [tech_debt_04_error_handling.md](./tech_debt_04_error_handling.md)                           | Historical | Error boundary cleanup notes. Re-validate against current typed route/service errors before implementation.        |
| [tech_debt_05_infrastructure_enhance.md](./tech_debt_05_infrastructure_enhance.md)           | Historical | Infrastructure enhancement backlog.                                                                                |
| [tech_debt_06_testing_docs.md](./tech_debt_06_testing_docs.md)                               | Historical | Test/docs debt checklist.                                                                                          |

## Baselines And Snapshots

| File                                                                           | Status   | Purpose                                                            |
| ------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------ |
| [refactor_round3_baseline_20260318.md](./refactor_round3_baseline_20260318.md) | Snapshot | Baseline record captured before the current V3 rounds accelerated. |
| [kimi_code_review.md](./kimi_code_review.md)                                   | Input    | External review snapshot that seeded the initial debt plans.       |

## Archived

| File                                                                       | Status   | Reason                                                                                                                                                           |
| -------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [tech_debt_02_orchestrator_merge.md](./tech_debt_02_orchestrator_merge.md) | Archived | Based on old file names, pre-facade orchestrator assumptions, and now-outdated merge strategy. Keep for history only; do not use it as an implementation source. |

## Working Rules

- Prefer the newest current-state plan over older tech debt notes when the two conflict.
- Treat module PRDs under `server/docs/` as the source of truth for effective behavior.
- When a plan is superseded, move it to the `Archived` section instead of editing history in place.
