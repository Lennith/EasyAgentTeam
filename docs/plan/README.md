# EasyAgentTeam Refactor Plans

This directory tracks current refactor plans, baseline snapshots, and archived debt notes for the repository.

## Current Plans

| File                                                                                                   | Status     | Purpose                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------ |
| [orchestrator_shared_abstraction_20260328.md](./orchestrator_shared_abstraction_20260328.md)           | Active     | Current-state plan for project/workflow orchestrator shared abstraction, known issues, and remaining work.         |
| [day1_main_tip_release_qa_execution_20260402.md](./day1_main_tip_release_qa_execution_20260402.md)     | Active     | Day1 execution checklist for main-tip release QA evidence and waiver handling.                                     |
| [day2_storage_boundary_lock_20260402.md](./day2_storage_boundary_lock_20260402.md)                     | Active     | Day2 storage boundary lock deliverables and acceptance checklist.                                                  |
| [day3_orchestrator_boundary_freeze_20260402.md](./day3_orchestrator_boundary_freeze_20260402.md)       | Active     | Day3 orchestrator/shared freeze deliverables and acceptance checklist.                                             |
| [day4_architecture_navigation_upgrade_20260402.md](./day4_architecture_navigation_upgrade_20260402.md) | Active     | Day4 architecture navigation upgrade deliverables and acceptance checklist.                                        |
| [day5_release_tail_debt_split_20260402.md](./day5_release_tail_debt_split_20260402.md)                 | Active     | Day5 release-tail debt split deliverables and acceptance checklist.                                                |
| [day6_gate_doc_linkage_20260402.md](./day6_gate_doc_linkage_20260402.md)                               | Active     | Day6 gate-doc linkage deliverables and acceptance checklist.                                                       |
| [tech_debt_01_api_routing_refactor.md](./tech_debt_01_api_routing_refactor.md)                         | Historical | Early routing refactor plan. Use current server routes and PRD state as the source of truth before implementation. |
| [tech_debt_03_storage_transaction.md](./tech_debt_03_storage_transaction.md)                           | Active     | Repository and UnitOfWork expansion plan for storage/runtime boundaries.                                           |
| [tech_debt_07_release_tail_closure_20260402.md](./tech_debt_07_release_tail_closure_20260402.md)       | Active     | Non-blocking release-tail debt list with owner/priority/exit criteria.                                             |
| [tech_debt_04_error_handling.md](./tech_debt_04_error_handling.md)                                     | Historical | Error boundary cleanup notes. Re-validate against current typed route/service errors before implementation.        |
| [tech_debt_05_infrastructure_enhance.md](./tech_debt_05_infrastructure_enhance.md)                     | Historical | Infrastructure enhancement backlog.                                                                                |
| [tech_debt_06_testing_docs.md](./tech_debt_06_testing_docs.md)                                         | Historical | Test/docs debt checklist.                                                                                          |
| [release_tail_retrospective_20260402.md](./release_tail_retrospective_20260402.md)                     | Snapshot   | 30-minute closure retrospective with next-round hard constraints.                                                  |

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
