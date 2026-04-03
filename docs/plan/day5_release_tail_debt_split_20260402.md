# Day5 Release-Tail Debt Split (2026-04-02)

## Goal

Move non-blocking unfinished items out of mainline PRDs into a dedicated debt list so release-complete statements remain stable and auditable.

## Day5 Deliverables

1. Dedicated debt list:
   - `docs/plan/tech_debt_07_release_tail_closure_20260402.md`
2. Debt format includes:
   - owner
   - priority
   - exit criteria
   - release-blocking flag
3. Plan index registration:
   - `docs/plan/README.md` marks this list as `Active`.

## Acceptance

- Non-blocking leftovers are tracked in debt list format rather than mixed into module PRD body.
