# Trigger Workspace PRD (last updated: 2026-05-06)

## Status

- Document status: `实装` (`implemented`)

## Goal

The Trigger workspace exposes Trigger Runtime controls inside the Workflow section. It lets users import trusted local trigger plugins, configure trigger schedules, run manual tests, and inspect trigger fire history linked to workflow runs.

## Current V1 Scope

- Add `#/workflow/triggers` under the Workflow navigation.
- List trigger plugins and trigger configs.
- Import a plugin from a local path.
- Create, update, enable, disable, and delete triggers.
- Configure trigger provider session mode: fresh per fire or reuse provider session across fires.
- Inspect and reset provider session bindings for reuse-mode triggers.
- Run a manual trigger test.
- Show trigger fire history and link associated workflow runs.

## Boundaries

- The dashboard never executes plugin code.
- The dashboard never creates workflow runs directly for triggers; it calls Trigger Runtime APIs.
- Trigger history is backend audit data. The dashboard does not infer fire status from workflow lists.

## Verification Notes

- V1 dashboard verification is covered by `pnpm --filter dashboard-v2 build`, `node tools/check-dashboard-api-boundaries.mjs`, and subagent code review.
- Browser-level click-through automation for `#/workflow/triggers` is not added in V1 because this repository does not currently carry a dashboard browser automation harness or dependency. This remains the tracked P2 gap for future UI regression coverage.
