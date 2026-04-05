---
name: template_bundle_guard
description: Validate and publish TemplateBundle to EasyAgentTeam backend with retry-friendly hints.
license: MIT
compatibility: local
---

# Template Bundle Guard

Use this skill before submission. It is the only allowed submission entry.

## Commands

- Check: `node .agent-tools/scripts/template_bundle_guard.mjs check`
- Publish: `node .agent-tools/scripts/template_bundle_guard.mjs publish`

## Reports

- `reports/template-guard/last_check.json|md`
- `reports/template-guard/last_publish.json|md`

## Behavior

- `check`: validate only; output structured errors and hints for retry.
- `publish`: always runs `check` first, then apply if check passes.
- `publish` never starts run lifecycle.
