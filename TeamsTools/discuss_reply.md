# Tool: `discuss_reply`

## Purpose
Reply to an existing discuss thread for a task.

## Required Arguments
- `to_role: <target_role>`
- `message: <reply_message>`
- `thread_id: <thread_id>`

## Optional Arguments
- `task_id: <task_id>` (uses active task context when omitted)
- `round: <positive_integer>`
- `in_reply_to: <message_or_request_id>`

## Minimal Example
```json
{
  "to_role": "eng_manager",
  "task_id": "task-impl-02",
  "thread_id": "task-impl-02-schema",
  "round": 2,
  "message": "Schema approved. Continue with v3 format."
}
```

## Backend Behavior
- Sent via `/messages/send` as `TASK_DISCUSS_REPLY`.

## Common Errors
- `MESSAGE_ROUTE_DENIED`
- `MESSAGE_TARGET_SESSION_NOT_FOUND`

## Next Action on Failure
Use `next_action` from tool error JSON and send one corrected reply.
