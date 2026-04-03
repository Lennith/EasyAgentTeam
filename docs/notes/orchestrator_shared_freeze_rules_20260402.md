# Orchestrator Shared Freeze Rules (2026-04-02)

## Purpose

Freeze one round of orchestrator/shared boundaries so project/workflow can stabilize on the current V3 skeleton instead of reopening internal abstraction churn.

## Scope

- Applies to `server/src/services/orchestrator/**`
- Focuses on shared skeleton, project/workflow adapters, and message routing/task-action seams

## Allowed In This Round

- Adapter/policy behavior fixes
- Shared template bugfixes that do not add a new naming family
- Dead code removal and contract narrowing when runtime behavior is unchanged

## Forbidden In This Round

- New shared `compat` seams
- New shared `helper` fallback layer that revives removed flow paths
- New shared `contract` naming family parallel to existing contract set
- Reintroducing `*-internal.ts` orchestration middle layers to bypass the shared templates

## Review Checklist

1. Entry orchestrators stay as facade + dependency composition.
2. Project/workflow divergence remains in adapter/policy only.
3. Any shared-file name containing `contract/helper/compat` is either already whitelisted or rejected.
4. API and event contracts remain externally frozen.

## Tooling

- Advisory check: `pnpm check:boundaries`
- Strict rehearsal: `pnpm check:boundaries:strict`
