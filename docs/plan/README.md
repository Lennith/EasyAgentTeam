# EasyAgentTeam Refactor Plans

This directory tracks current effective implementation plans.

## Current Plans

| File                                                                                                   | Status | Purpose                                                                                                    |
| ------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------- |
| [orchestrator_shared_abstraction_20260328.md](./orchestrator_shared_abstraction_20260328.md)           | Active | Current-state plan for project/workflow orchestrator shared abstraction, known issues, and remaining work. |
| [day1_main_tip_release_qa_execution_20260402.md](./day1_main_tip_release_qa_execution_20260402.md)     | Active | Day1 execution checklist for main-tip release QA evidence and waiver handling.                             |
| [day2_storage_boundary_lock_20260402.md](./day2_storage_boundary_lock_20260402.md)                     | Active | Day2 storage boundary lock deliverables and acceptance checklist.                                          |
| [day3_orchestrator_boundary_freeze_20260402.md](./day3_orchestrator_boundary_freeze_20260402.md)       | Active | Day3 orchestrator/shared freeze deliverables and acceptance checklist.                                     |
| [day4_architecture_navigation_upgrade_20260402.md](./day4_architecture_navigation_upgrade_20260402.md) | Active | Day4 architecture navigation upgrade deliverables and acceptance checklist.                                |
| [day5_release_tail_debt_split_20260402.md](./day5_release_tail_debt_split_20260402.md)                 | Active | Day5 release-tail debt split deliverables and acceptance checklist.                                        |
| [day6_gate_doc_linkage_20260402.md](./day6_gate_doc_linkage_20260402.md)                               | Active | Day6 gate-doc linkage deliverables and acceptance checklist.                                               |
| [tech_debt_03_storage_transaction.md](./tech_debt_03_storage_transaction.md)                           | Active | Repository and UnitOfWork expansion plan for storage/runtime boundaries.                                   |
| [tech_debt_07_release_tail_closure_20260402.md](./tech_debt_07_release_tail_closure_20260402.md)       | Active | Non-blocking release-tail debt list with owner/priority/exit criteria.                                     |

## Working Rules

- Keep only current effective behavior and implementation guidance in active plan docs.
- Treat module PRDs under `server/docs/` as the source of truth for effective behavior.
