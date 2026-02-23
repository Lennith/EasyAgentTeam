# Tool: `discuss_close`

## Purpose
Close a discuss thread with final decision, assumption, or stop reason.

## Required Arguments
- `to_role: <target_role>`
- `message: <close_summary>`
- `thread_id: <thread_id>`

## Optional Arguments
- `task_id: <task_id>` (uses active task context when omitted)
- `round: <positive_integer>`

## Minimal Example
```json
{
  "to_role": "pm_owner",
  "task_id": "task-impl-02",
  "thread_id": "task-impl-02-schema",
  "round": 3,
  "message": "Thread closed with agreed schema v3."
}
```

## Backend Behavior
- Sent via `/messages/send` as `TASK_DISCUSS_CLOSED`.

## Common Errors
- `MESSAGE_ROUTE_DENIED`
- `MESSAGE_TARGET_SESSION_NOT_FOUND`

## Next Action on Failure
Follow `next_action` from tool error JSON and resend the close message once.
