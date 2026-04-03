# Day6 Gate-Doc Linkage (2026-04-02)

## Goal

After each standard gate run, produce machine-readable and human-readable linkage output so manual cross-checking is no longer required.

## Day6 Deliverables

1. Gate script auto-generates doc linkage index:
   - `.e2e-workspace/standard-gate/<timestamp>/gate_doc_index.json`
   - `.e2e-workspace/standard-gate/<timestamp>/gate_doc_index.md`
2. Gate script prints key linkage hints to terminal:
   - commit
   - smoke/project/workflow pass state
   - matched QA report path
   - waiver flag
   - known external issue summary
3. Contract schema:
   - `docs/contracts/gate-doc-index.contract.json`
4. Manual regenerate entry:
   - `pnpm gate:index -- --summary <run_summary.md>`

## Acceptance

- Running `pnpm gate:standard` emits direct index pointers and key linkage fields.
- Running `pnpm gate:index` on any existing `run_summary.md` reproduces the same linkage fields.
