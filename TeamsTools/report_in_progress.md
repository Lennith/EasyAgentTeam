# Tool: `task_report_in_progress`

## Purpose
Submit non-terminal progress update for one active task.

## Required Arguments
- `content: <one_paragraph_progress_summary>`

## Optional Arguments
- `task_id: <task_id>` (uses active task context when omitted)
- `progress_file: <progress_file_path>`

## Minimal Example
```json
{
  "content": "Finished parser skeleton and mapped legacy packet fields.",
  "progress_file": "Agents/dev_impl/progress.md"
}
```

## Backend Behavior
- Sent as `TASK_REPORT` with `report_mode=IN_PROGRESS`.
- Accepted with weak validation (task binding + non-empty content).

## Common Errors
- `TASK_BINDING_REQUIRED`
- `TASK_RESULT_INVALID_TARGET`

## Next Action on Failure
Use `next_action` from tool error JSON and resend once.
