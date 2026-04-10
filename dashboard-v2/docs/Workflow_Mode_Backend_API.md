# Workflow Mode Backend API

## 1. Scope

This document defines the current backend contract used by dashboard-v2 for workflow mode.

It covers:

- workflow template management
- workflow run lifecycle
- workflow runtime inspection
- workflow task actions
- workflow sessions and routed messages
- workflow orchestrator settings and dispatch
- workflow recurring loop and schedule semantics
- workflow agent chat entrypoints

## 2. Conventions

- Base URL uses the same backend host as the rest of the dashboard.
- Request bodies accept snake_case and camelCase aliases for key fields.
- Response bodies use the current runtime model fields already consumed by dashboard-v2.
- Workflow run creation is workspace-path based.

## 3. Data Models

### 3.1 WorkflowTemplateTaskRecord

```json
{
  "taskId": "wf_planning",
  "title": "Complete product planning",
  "ownerRole": "pm",
  "parentTaskId": "wf_root",
  "dependencies": ["wf_root"],
  "writeSet": ["docs/prd.md"],
  "acceptance": ["contains scope and risks"],
  "artifacts": ["docs/prd.md"]
}
```

### 3.2 WorkflowTemplateRecord

```json
{
  "schemaVersion": "1.0",
  "templateId": "gesture_app",
  "name": "Gesture App Workflow",
  "description": "Multi-phase delivery workflow",
  "tasks": [],
  "routeTable": { "pm": ["eng_manager"] },
  "taskAssignRouteTable": { "eng_manager": ["android_dev"] },
  "routeDiscussRounds": { "pm": { "eng_manager": 3 } },
  "defaultVariables": { "platform": "android" },
  "createdAt": "2026-03-12T00:00:00.000Z",
  "updatedAt": "2026-03-12T00:00:00.000Z"
}
```

### 3.3 WorkflowRunRecord

```json
{
  "schemaVersion": "2.0",
  "runId": "gesture_run_01",
  "templateId": "gesture_app",
  "name": "Gesture App Run",
  "description": "Android gesture application",
  "workspacePath": "D:\\AgentWorkSpace\\TestTeam\\TestWorkflowSpace",
  "tasks": [],
  "status": "created",
  "mode": "loop",
  "loopEnabled": true,
  "scheduleEnabled": false,
  "originRunId": "gesture_seed_run",
  "autoDispatchEnabled": true,
  "autoDispatchRemaining": 5,
  "autoDispatchInitialRemaining": 5,
  "holdEnabled": false,
  "reminderMode": "backoff",
  "createdAt": "2026-03-12T00:00:00.000Z",
  "updatedAt": "2026-03-12T00:00:00.000Z"
}
```

Semantics:

- `autoDispatchRemaining` is the current run's remaining auto-dispatch quota.
- `autoDispatchInitialRemaining` is the baseline quota used when recurring creates the next child run.

### 3.4 WorkflowRunRuntimeSnapshot

```json
{
  "runId": "gesture_run_01",
  "status": "running",
  "active": true,
  "updatedAt": "2026-03-12T00:10:00.000Z",
  "counters": {
    "total": 6,
    "planned": 0,
    "ready": 1,
    "dispatched": 1,
    "mayBeDone": 0,
    "blocked": 2,
    "inProgress": 1,
    "done": 2,
    "canceled": 0
  },
  "tasks": []
}
```

## 4. Workflow Orchestrator Status API

### 4.1 `GET /api/workflow-orchestrator/status`

Returns global workflow orchestrator status.

Response fields:

- `enabled`
- `running`
- `intervalMs`
- `maxConcurrentDispatches`
- `inFlightDispatchSessions`
- `lastTickAt`
- `started`
- `activeRunIds`
- `activeRunCount`
- optional `runs`

## 5. Workflow Template API

### 5.1 `GET /api/workflow-templates`

Returns:

```json
{
  "items": [],
  "total": 0
}
```

### 5.2 `GET /api/workflow-templates/:template_id`

Returns a single `WorkflowTemplateRecord`.

### 5.3 `POST /api/workflow-templates`

Required fields:

- `template_id`
- `name`
- `tasks`

Task item fields:

- `task_id`
- `title`
- `owner_role`
- optional `parent_task_id`
- optional `dependencies`
- optional `write_set`
- optional `acceptance`
- optional `artifacts`

Optional top-level fields:

- `description`
- `route_table`
- `task_assign_route_table`
- `route_discuss_rounds`
- `default_variables`

### 5.4 `PATCH /api/workflow-templates/:template_id`

Allows partial updates of:

- `name`
- `description`
- `tasks`
- `route_table`
- `task_assign_route_table`
- `route_discuss_rounds`
- `default_variables`

### 5.5 `DELETE /api/workflow-templates/:template_id`

Returns removal metadata.

## 6. Workflow Run API

### 6.1 `GET /api/workflow-runs`

Returns run list with `items` and `total`.

### 6.2 `POST /api/workflow-runs`

Required fields:

- `template_id`
- `workspace_path`

Optional fields:

- `run_id`
- `name`
- `description`
- `variables`
- `task_overrides`
- `auto_start`
- `mode`
- `loop_enabled`
- `schedule_enabled`
- `schedule_expression`
- `is_schedule_seed`
- `auto_dispatch_enabled`
- `auto_dispatch_remaining`

Run create semantics:

- `auto_dispatch_remaining` initializes both `autoDispatchRemaining` and `autoDispatchInitialRemaining`.

### 6.3 `GET /api/workflow-runs/:run_id`

Returns a single `WorkflowRunRecord`.

### 6.4 `POST /api/workflow-runs/:run_id/start`

Returns:

```json
{
  "runtime": {
    "runId": "gesture_run_01",
    "status": "running",
    "active": true
  },
  "run": {}
}
```

### 6.5 `POST /api/workflow-runs/:run_id/stop`

Returns the stopped runtime state and run payload.

### 6.6 `GET /api/workflow-runs/:run_id/status`

Returns workflow runtime status.

## 7. Workflow Runtime Inspection API

### 7.1 `GET /api/workflow-runs/:run_id/task-runtime`

Returns `WorkflowRunRuntimeSnapshot`.

### 7.2 `GET /api/workflow-runs/:run_id/task-tree-runtime`

Returns task runtime graph with:

- `roots`
- `nodes`
- `edges`
- `counters`

### 7.3 `GET /api/workflow-runs/:run_id/task-tree`

Supports optional query parameters:

- `focus_task_id`
- `max_descendant_depth`
- `include_external_dependencies`

### 7.4 `GET /api/workflow-runs/:run_id/tasks/:task_id/detail`

Returns task detail and lifecycle events.

## 8. Workflow Task Action API

### 8.1 `POST /api/workflow-runs/:run_id/task-actions`

Supported action types:

- `TASK_CREATE`
- `TASK_DISCUSS_REQUEST`
- `TASK_DISCUSS_REPLY`
- `TASK_DISCUSS_CLOSED`
- `TASK_REPORT`

Response shape:

```json
{
  "success": true,
  "requestId": "req_x",
  "actionType": "TASK_REPORT",
  "partialApplied": false,
  "appliedTaskIds": ["wf_planning"],
  "rejectedResults": [],
  "snapshot": {}
}
```

## 9. Workflow Session and Message API

### 9.1 `GET /api/workflow-runs/:run_id/sessions`

Returns workflow sessions for the run.

### 9.2 `POST /api/workflow-runs/:run_id/sessions`

Registers or upserts a workflow session.

Accepted fields:

- `role`
- `session_id`
- `status`
- `provider_id`
- `provider`
- `provider_session_id`

### 9.3 `POST /api/workflow-runs/:run_id/messages/send`

Sends a manager-routed workflow message.

Accepted fields include:

- `from_agent`
- `from_session_id`
- `to` or `to_role`
- `to_session_id`
- `message_type`
- `task_id`
- `content`
- `request_id`
- `parent_request_id`
- `discuss`

## 10. Workflow Orchestrator Control API

### 10.1 `GET /api/workflow-runs/:run_id/orchestrator/settings`

Returns:

- `run_id`
- `mode`
- `loop_enabled`
- `schedule_enabled`
- `schedule_expression`
- `is_schedule_seed`
- `origin_run_id`
- `last_spawned_run_id`
- `spawn_state`
- `auto_dispatch_enabled`
- `auto_dispatch_remaining`
- `auto_dispatch_initial_remaining`
- `hold_enabled`
- `reminder_mode`
- `recurring_status`
- `updated_at`

### 10.2 `PATCH /api/workflow-runs/:run_id/orchestrator/settings`

Allows partial update of:

- `auto_dispatch_enabled`
- `auto_dispatch_remaining`
- `hold_enabled`
- `reminder_mode`
- `mode`
- `loop_enabled`
- `schedule_enabled`
- `schedule_expression`
- `is_schedule_seed`

Patch semantics:

- if `auto_dispatch_remaining` is provided, backend updates both the current remaining quota and the recurring baseline quota

### 10.3 `POST /api/workflow-runs/:run_id/orchestrator/dispatch`

Request fields:

- `role`
- `task_id`
- `force`
- `only_idle`

Response includes:

- `runId`
- `dispatchedCount`
- `remainingBudget`
- `results[]`

`results[]` item fields:

- `role`
- `sessionId`
- `taskId`
- `dispatchKind`
- `messageId`
- `requestId`
- `outcome`
- `reason`

## 11. Workflow Recurring Semantics

### 11.1 Loop

- `mode=loop` and `loop_enabled=true`
- parent run must be `finished`
- recurring creates a new child run and starts it
- child run uses:
  - `autoDispatchInitialRemaining = parent.autoDispatchInitialRemaining`
  - `autoDispatchRemaining = parent.autoDispatchInitialRemaining`

### 11.2 Schedule

- `mode=schedule` and `schedule_enabled=true`
- schedule seed is the only record that owns the trigger
- child run is not a new seed
- child run also resets quota from `autoDispatchInitialRemaining`

## 12. Runtime Semantics

### 12.1 Reminder Payload

Workflow reminders use the shared task-aware reminder payload contract with:

- `taskId`
- `summary`
- `task`
- `reminder.open_task_ids`
- `reminder.open_task_titles`
- `taskHint`
- `envelope.correlation.task_id`

### 12.2 Reminder Redispatch

Task-bound reminder messages are eligible for message dispatch selection. This keeps workflow reminders actionable instead of remaining as undelivered inbox entries.

### 12.3 Auto Dispatch Budget

- `autoDispatchRemaining` is a runtime-depleting counter
- only successful automatic task dispatch consumes the counter
- recurring child creation does not inherit the already-depleted current value

## 13. Retired Workflow API

These endpoints remain retired and return `410`:

- `GET /api/workflow-runs/:run_id/step-runtime`
- `POST /api/workflow-runs/:run_id/step-actions`

## 14. Status

Status: `ACTIVE`
