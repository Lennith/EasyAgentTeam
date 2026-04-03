# Tech Debt 07: Release Tail Closure (2026-04-02)

## Goal

Separate "not finished in this round but not release-blocking" items from mainline PRDs, so orchestrator/storage closure is no longer mixed with rolling follow-ups.

## Debt List

| Item                                                                       | Owner                | Priority | Exit Criteria                                                                                                          | Release Blocking |
| -------------------------------------------------------------------------- | -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Storage naming normalization (`repository/store/storage` term consistency) | Server Runtime       | P1       | PRD_Data_Storage terms and code comments converge to one naming map; no ambiguous cross-layer alias in new code review | No               |
| Large file responsibility split (high-churn orchestrator/service files)    | Orchestrator Runtime | P1       | Target files have clear responsibility map and at least one split proposal validated by tests                          | No               |
| Head-level release QA automation closure                                   | QA/Gate Tooling      | P1       | release gate can output reproducible head-tip evidence index and link to report/waiver metadata without manual grep    | No               |
| Documentation index parity (`architecture-and-api` + PRD links)            | Docs Maintainer      | P2       | Main entry page covers runtime modes, key entrypoints, PRD navigation, data boundary, and gate paths                   | No               |

## Tracking Rules

1. New non-blocking leftovers must be added here instead of being embedded in module PRD body.
2. Every item must have owner + exit criteria before it enters active queue.
3. If an item becomes release-blocking, mark it in this table and promote it to release checklist.
