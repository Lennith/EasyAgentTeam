# Workflow Mode Backend API (V1)

## 1. Scope

This document defines backend API contract for workflow mode integration in dashboard-v2.

- Workflow template management
- Workflow run lifecycle management
- Workflow orchestrator runtime status
- Lock behavior change note (API path unchanged)

## 2. Common Conventions

- Base URL: same as existing backend (for example `http://127.0.0.1:3000`).
- Request body accepts both snake_case and camelCase aliases for key fields.
- Response payload uses camelCase model fields.
- Standard error shape:

```json
{
  "error_code": "WORKFLOW_RUN_INPUT_INVALID",
  "error": { "code": "WORKFLOW_RUN_INPUT_INVALID", "message": "template_id is required" },
  "message": "template_id is required",
  "hint": null,
  "next_action": null
}
```

## 3. Data Models

### 3.1 WorkflowTemplateTaskRecord

```json
{
  "taskId": "task_prd",
  "title": "Write PRD for {{module}}",
  "ownerRole": "PM",
  "parentTaskId": "task_root",
  "dependencies": ["task_root"],
  "writeSet": ["docs/prd.md"],
  "acceptance": ["contains scope and risks"],
  "artifacts": ["docs/prd.md"]
}
```

### 3.2 WorkflowTemplateRecord

```json
{
  "schemaVersion": "1.0",
  "templateId": "prd_template",
  "name": "PRD Template",
  "description": "Reusable PRD workflow",
  "tasks": [],
  "routeTable": { "PM": ["planner"] },
  "taskAssignRouteTable": { "PM": ["planner"] },
  "routeDiscussRounds": { "PM": { "planner": 2 } },
  "defaultVariables": { "module": "billing" },
  "createdAt": "2026-02-25T00:00:00.000Z",
  "updatedAt": "2026-02-25T00:00:00.000Z"
}
```

### 3.3 WorkflowRunRecord

```json
{
  "schemaVersion": "1.0",
  "runId": "prd_run_01",
  "templateId": "prd_template",
  "name": "PRD Run",
  "description": "Round29 run",
  "workspacePath": "D:\\AgentWorkSpace\\TestTeam\\TestWorkflowSpace",
  "workspaceBindingMode": "project",
  "boundProjectId": "project_x",
  "variables": { "module": "billing" },
  "taskOverrides": { "task_prd": "Write PRD for {{module}} V2" },
  "tasks": [],
  "status": "created",
  "createdAt": "2026-02-25T00:00:00.000Z",
  "updatedAt": "2026-02-25T00:00:00.000Z",
  "startedAt": "2026-02-25T00:01:00.000Z",
  "stoppedAt": "2026-02-25T00:10:00.000Z",
  "lastHeartbeatAt": "2026-02-25T00:10:00.000Z"
}
```

### 3.4 Workflow runtime status

```json
{
  "runId": "prd_run_01",
  "status": "running",
  "active": true,
  "startedAt": "2026-02-25T00:01:00.000Z",
  "stoppedAt": null,
  "lastHeartbeatAt": "2026-02-25T00:02:00.000Z"
}
```

`status` enum: `created | running | stopped | finished | failed`.

## 4. Workflow Orchestrator API

### 4.1 GET `/api/workflow-orchestrator/status`

Returns global orchestrator runtime state.

Response 200:

```json
{
  "started": true,
  "activeRunIds": ["prd_run_01"],
  "activeRunCount": 1
}
```

## 5. Workflow Template API

### 5.1 GET `/api/workflow-templates`

Response 200:

```json
{
  "items": [],
  "total": 0
}
```

### 5.2 GET `/api/workflow-templates/:template_id`

- 200: returns `WorkflowTemplateRecord`
- 404: `WORKFLOW_TEMPLATE_NOT_FOUND`

### 5.3 POST `/api/workflow-templates`

Request body required:

- `template_id` or `templateId`
- `name`
- `tasks` (non-empty)

Task item accepts:

- `task_id`/`taskId`
- `title`
- `owner_role`/`ownerRole`
- optional: `parent_task_id`/`parentTaskId`, `dependencies`, `write_set`/`writeSet`, `acceptance`, `artifacts`

Response:

- 201: `WorkflowTemplateRecord`
- 400: `WORKFLOW_TEMPLATE_INPUT_INVALID` or workflow validation errors
- 409: `WORKFLOW_TEMPLATE_EXISTS`

### 5.4 PATCH `/api/workflow-templates/:template_id`

Partial update fields:

- `name`, `description`, `tasks`
- `route_table`/`routeTable`
- `task_assign_route_table`/`taskAssignRouteTable`
- `route_discuss_rounds`/`routeDiscussRounds`
- `default_variables`/`defaultVariables`

Response:

- 200: `WorkflowTemplateRecord`
- 404: `WORKFLOW_TEMPLATE_NOT_FOUND`

### 5.5 DELETE `/api/workflow-templates/:template_id`

Response 200:

```json
{
  "templateId": "prd_template",
  "removedAt": "2026-02-25T00:00:00.000Z"
}
```

## 6. Workflow Run API

### 6.1 GET `/api/workflow-runs`

Response 200:

```json
{
  "items": [],
  "total": 0
}
```

### 6.2 POST `/api/workflow-runs`

Required:

- `template_id` or `templateId`

Binding mode:

- `workspace_binding_mode` / `workspaceBindingMode`:
  - `standalone` (default): requires `workspace_path` / `workspacePath`
  - `project`: requires `project_id` / `projectId` and backend resolves workspace from project

Optional:

- `run_id` / `runId` (auto-generated if absent)
- `name`, `description`
- `variables`
- `task_overrides` / `taskOverrides`

Response:

- 201: `WorkflowRunRecord` with resolved tasks (`resolvedTitle` already rendered by variables)
- 400: `WORKFLOW_RUN_INPUT_INVALID`
- 404: `WORKFLOW_TEMPLATE_NOT_FOUND`
- 409: `WORKFLOW_RUN_EXISTS`

### 6.3 GET `/api/workflow-runs/:run_id`

- 200: `WorkflowRunRecord`
- 404: `WORKFLOW_RUN_NOT_FOUND`

### 6.4 POST `/api/workflow-runs/:run_id/start`

Response 200:

```json
{
  "runtime": {
    "runId": "prd_run_01",
    "status": "running",
    "active": true
  },
  "run": {}
}
```

### 6.5 POST `/api/workflow-runs/:run_id/stop`

Response 200:

```json
{
  "runtime": {
    "runId": "prd_run_01",
    "status": "stopped",
    "active": false
  },
  "run": {}
}
```

### 6.6 GET `/api/workflow-runs/:run_id/status`

- 200: runtime status object (`runId/status/active/startedAt/stoppedAt/lastHeartbeatAt`)
- 404: `WORKFLOW_RUN_NOT_FOUND`

### 6.7 GET `/api/workflow-runs/:run_id/step-runtime`

Response 200:

```json
{
  "runId": "prd_run_01",
  "status": "running",
  "active": true,
  "updatedAt": "2026-03-04T12:00:00.000Z",
  "counters": {
    "total": 6,
    "ready": 1,
    "blocked": 5,
    "inProgress": 0,
    "done": 0,
    "failed": 0,
    "canceled": 0
  },
  "steps": [
    {
      "taskId": "task-discuss-lead-plan",
      "state": "READY",
      "blockedBy": [],
      "blockedReasons": [],
      "lastTransitionAt": "2026-03-04T12:00:00.000Z",
      "transitionCount": 2,
      "transitions": []
    }
  ]
}
```

### 6.8 POST `/api/workflow-runs/:run_id/step-actions`

Request body:

```json
{
  "action_type": "STEP_REPORT",
  "from_agent": "lead",
  "results": [
    {
      "task_id": "task-discuss-lead-plan",
      "outcome": "DONE",
      "summary": "lead completed"
    }
  ]
}
```

Response 200:

```json
{
  "success": true,
  "requestId": "req_x",
  "partialApplied": false,
  "appliedTaskIds": ["task-discuss-lead-plan"],
  "rejectedResults": [],
  "snapshot": {}
}
```

### 6.9 GET `/api/workflow-runs/:run_id/task-tree-runtime`

Response 200:

```json
{
  "run_id": "prd_run_01",
  "generated_at": "2026-03-04T12:00:00.000Z",
  "status": "running",
  "active": true,
  "roots": ["task-discuss-lead-plan"],
  "nodes": [
    {
      "taskId": "task-discuss-lead-plan",
      "resolvedTitle": "Lead plan",
      "ownerRole": "lead",
      "runtime": {
        "taskId": "task-discuss-lead-plan",
        "state": "READY",
        "blockedBy": [],
        "blockedReasons": [],
        "lastTransitionAt": "2026-03-04T12:00:00.000Z",
        "transitionCount": 2,
        "transitions": []
      }
    }
  ],
  "edges": [],
  "counters": {
    "total": 6,
    "ready": 1,
    "blocked": 5,
    "inProgress": 0,
    "done": 0,
    "failed": 0,
    "canceled": 0
  }
}
```

## 7. Frontend Integration Notes

- Suggested page split:
  - Workflow Templates list/detail editor
  - Workflow Runs list/detail
  - Runtime control panel (`start/stop`) + status polling
  - Global orchestrator status card
- Suggested polling:
  - Run detail status: every 2-5 seconds when `status=running`
  - Orchestrator status: every 5-10 seconds
  - Runtime tree (`task-tree-runtime`): every 5 seconds when `status=running`
- UI should treat backend as source of truth for status transitions.
- Hard-cut behavior: no backward compatibility for old workflow/session payloads.

## 8. Lock API Behavior Change (Important)

Lock endpoints are still project-routed:

- `POST /api/projects/:id/locks/acquire`
- `POST /api/projects/:id/locks/renew`
- `POST /api/projects/:id/locks/release`
- `GET /api/projects/:id/locks`

But lock scope is now workspace-global with hierarchical conflict:

- Existing file lock blocks acquiring ancestor dir lock.
- Existing dir lock blocks acquiring descendant file/dir lock.
- Same path file-file and dir-dir conflict.
- Sibling non-overlap paths do not conflict.
- `target_type` defaults to `file`; use `target_type=dir` explicitly for directory locks.

`GET /locks` can return active locks from other owners in same workspace (for example future `workflow_run` owners), because mutual exclusion is no longer isolated by project lock directory.
