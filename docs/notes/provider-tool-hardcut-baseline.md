# Provider/Tool Hardcut Baseline Snapshot

- branch: codex/provider-tool-hardcut-v1
- captured_at: 2026-03-09T23:58:40+08:00
- goal: record baseline before hard-cut refactor

## Commands

1. `pnpm --filter @autodev/server run test -- --test-name-pattern "runtime settings|workflow"`

- result: pass
- summary: tests=121 pass=116 fail=0 skip=5

2. `pnpm --filter dashboard-v2 build`

- result: pass

## Notes

- Baseline was captured on clean worktree after branch creation.
- Next checkpoints will refactor provider runtime, tool injection, contract fields, and MiniMax settings reset semantics.
