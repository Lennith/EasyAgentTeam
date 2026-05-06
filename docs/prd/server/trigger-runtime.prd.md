# Trigger Runtime PRD (last updated: 2026-05-06)

## Status

- Document status: `实装` (`implemented`)

## Goal

Trigger Runtime lets EasyAgentTeam run trusted local trigger plugins on a schedule and turn plugin decisions into workflow runs. It is an upstream workflow entrypoint, not a replacement for Workflow Runtime.

## Current V1 Scope

- Import trusted local JS/TS/TSX trigger plugin packages with `trigger.plugin.yaml`.
- Store plugin registry, trigger config, and audit data under the existing file-backed `dataRoot`.
- Run plugin hooks in a worker with hook timeout; plugin failure is scoped to the current trigger fire.
- Let plugins decide whether a workflow should run and provide variables/task overrides.
- Create and start ordinary one-shot workflow runs through the existing workflow lifecycle.
- Support `sessionMode=fresh|reuse_provider_session`; reuse mode keeps workflow runs one-shot while carrying the provider session id across trigger fires.
- Store provider session bindings as Trigger Runtime state keyed by trigger, workflow template, role, and provider.
- Record trigger fire audit and expose run history through the Trigger API.

## Boundaries

- V1 treats plugins as trusted host-local code. It does not provide a security sandbox.
- V1 does not support plugin `package.json`, external dependency install, remote package install, or framework-provided KV.
- Plugins own their business state through their plugin data directory.
- Trigger Runtime must not let plugins write workflow runtime state directly.
- Provider session bindings are framework orchestration state, not plugin KV. Plugins still own only their own data directory.
- `reuse_provider_session` permits only one active fire per trigger. If a previous workflow run is still active, the next due tick is recorded as skipped with `session_binding_busy`.
- Retry policies are out of scope for V1; failures are recorded and the next scheduled check proceeds normally.

## Success Criteria

- A test plugin can fire a workflow run from a configured interval.
- A plugin hook timeout or exception does not crash the server or workflow orchestrator.
- Dashboard users can import a plugin, configure a trigger, test it manually, and inspect trigger run history.
- Dashboard users can choose fresh provider sessions or provider session reuse and reset a trigger's saved provider session binding.
- DPAgent-backed workflow validation can complete at least 5 stable trigger fires.
