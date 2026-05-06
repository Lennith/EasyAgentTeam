# Trigger Runtime API Spec (last updated: 2026-05-06)

Document status: `实装` (`implemented`)

## Public Endpoints

- `GET /api/trigger-plugins`
- `POST /api/trigger-plugins/import`
- `GET /api/triggers`
- `POST /api/triggers`
- `PATCH /api/triggers/:trigger_id`
- `DELETE /api/triggers/:trigger_id`
- `POST /api/triggers/:trigger_id/test`
- `GET /api/triggers/:trigger_id/runs`
- `GET /api/triggers/:trigger_id/session-bindings`
- `POST /api/triggers/:trigger_id/session-bindings/reset`

## Plugin Package Contract

Each plugin package is a local directory with `trigger.plugin.yaml`:

```yaml
schema_version: "1.0"
plugin_id: hello-trigger
name: Hello Trigger
description: Optional description
entry: index.ts
```

The entry module must export:

```ts
export async function doCheck(ctx): Promise<TriggerCheckResult>;
export async function onCheckResult(ctx, result): Promise<TriggerAction | null>;
export async function onWorkflowCompleted?(ctx, completion): Promise<CompletionVerdict>;
```

## Trigger Config Contract

`POST /api/triggers` accepts:

- `trigger_id`
- `plugin_id`
- `enabled`
- `interval_seconds`
- `workflow_template_id`
- `workspace_path`
- `default_variables`
- `hook_timeout_ms`
- `session_mode`: `fresh` or `reuse_provider_session`; default is `fresh`

`PATCH /api/triggers/:trigger_id` accepts the same mutable fields except `trigger_id`.

`GET /api/triggers/:trigger_id/session-bindings` returns provider session bindings owned by Trigger Runtime:

- `bindingId`
- `triggerId`
- `workflowTemplateId`
- `role`
- `provider`
- `providerSessionId?`
- `activeFireId?`
- `activeWorkflowRunId?`
- `lastFireId?`
- `lastWorkflowRunId?`

`POST /api/triggers/:trigger_id/session-bindings/reset` removes saved bindings. The optional body can narrow reset by `role` and `provider`.

## Runtime Behavior

- Trigger checks run only for enabled triggers whose `nextCheckAt` is due.
- Manual test runs the same hook flow immediately.
- If `doCheck` returns `need_trigger=false`, the fire is recorded as skipped.
- If `onCheckResult` returns no action or `should_trigger=false`, the fire is recorded as skipped.
- If action triggers, the backend creates and starts an ordinary workflow run and records the run id in trigger audit.
- `fresh` mode registers workflow sessions without cross-run provider session reuse.
- `reuse_provider_session` mode still creates a new ordinary workflow run for every fire, but injects the saved `providerSessionId` into the run session so DPAgent/Codex/Minimax can resume the underlying provider conversation.
- `reuse_provider_session` mode keeps only one active fire per trigger. If a previous workflow run has not reached `finished` or `failed`, the next check is skipped with reason `session_binding_busy:<runId>`.
- When a reused run reaches a terminal state, Trigger Runtime reads workflow sessions, persists observed provider session ids back to bindings, and clears the active binding state.
- Hook exceptions and timeouts are recorded as failed fire results; they do not crash the server.
- Completion hook is called when the associated workflow run reaches `finished` or `failed`.
