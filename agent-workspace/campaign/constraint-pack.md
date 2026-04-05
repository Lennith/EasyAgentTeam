# External Agent Constraint Pack (Base)

## Core Rules

- Every template must be goal-oriented and reusable; avoid one-off role designs.
- Project mode must include a dedicated QA guard role with `_qa_guard` suffix.
- Workflow mode must include at least 3 steps and a final QA acceptance step.
- All route references must stay within backend existing + current bundle agent closure.
- Run policy is create-first and explicit-start; never rely on auto-start defaults.

## Per-Step Checks

- Step 1 Goal: scope, success criteria, evidence targets are explicit.
- Step 2 Roles: role responsibility boundaries are clear and non-overlapping.
- Step 3 Agents: prompts include workspace contract and allowed API constraints.
- Step 4 Structure: dependencies are acyclic and owner-role assignments are valid.
- Step 5 Bundle: contract validation and conflict pre-check must pass.
- Step 6 Register/Run: apply result and runtime convergence evidence are recorded.

## Incremental Updates

- [Round 1] Enforce no-subtask policy by default in every task acceptance text unless explicitly allowed by controller.
- [Round 1] Enforce text-native artifact extensions only (.md/.json/.csv/.txt/.yml/.yaml), no office/binary outputs.
- [Round 1] Enforce concise execution outputs and avoid unrelated workspace scans to reduce runner timeout risk.
- [Round 3] Enforce explicit write_set boundaries for every task; artifacts must be covered by write_set paths.
- [Round 3] Enforce no cross-task write_set overlap to reduce ownership ambiguity and runtime collision.
- [Round 4] Add ownership-boundary guideline: each task should explicitly state "only update/report this task".
- [Round 5] Add measurable numeric limits guideline (size/count/SLA) in task contracts to reduce timeout risk.
