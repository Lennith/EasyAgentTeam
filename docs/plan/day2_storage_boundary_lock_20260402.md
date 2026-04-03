# Day2 Storage Boundary Lock (2026-04-02)

## Goal

Freeze storage-layer ownership so future changes do not drift between `repository / store / storage`.

## Day2 Deliverables

1. PRD_Data_Storage includes:
   - allowed change landing list
   - forbidden change list
   - review checklist
   - owner matrix ("who changes where")
2. Lightweight boundary check command exists:
   - `pnpm check:boundaries` (advisory)
   - `pnpm check:boundaries:strict` (strict rehearsal)
3. Route boundary is enforced by rule scan:
   - no direct route import to `data/repository`, `data/store`, `data/storage`, `data/file-utils`

## Acceptance

- `pnpm check:boundaries` exits successfully and prints no boundary warning.
- PRD_Data_Storage section 9 can be used directly as review criteria for storage-related PRs.
