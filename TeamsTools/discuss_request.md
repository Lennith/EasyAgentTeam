# Tool: `discuss_request`

## Purpose
Ask another role for clarification/decision on a specific task.

## Required Arguments
- `to_role: <target_role>`
- `message: <request_message>`

## Optional Arguments
- `task_id: <task_id>` (uses active task context when omitted)
- `thread_id: <thread_id>` (auto-generated when omitted)
- `round: <positive_integer>`

## Minimal Example
```json
{
  "to_role": "pm_owner",
  "task_id": "task-impl-02",
  "thread_id": "task-impl-02-schema",
  "round": 1,
  "message": "Need final schema for export payload."
}
```

## Backend Behavior
- Sent via `/messages/send` as `TASK_DISCUSS_REQUEST`.
- Manager-routed and route-table guarded.

## Common Errors
- `MESSAGE_ROUTE_DENIED`
- `MESSAGE_TARGET_SESSION_NOT_FOUND`
- `MESSAGE_TYPE_INVALID`

## Next Action on Failure
Read `next_action` from tool error JSON and retry with corrected target/payload.
