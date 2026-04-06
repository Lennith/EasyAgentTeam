# Data Placement Rules

- `repository/`: the only public data access seam for application code.
- Import concrete repository seams from their domain folders directly; do not add or keep root-level compatibility re-exports under `repository/`.
- `internal/persistence/`: storage internals only; routes and services must not import it directly.
- Do not add new top-level `*-store.ts` files or parallel naming families under `data/`.
