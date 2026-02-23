# Tool: `task_report_done`

## Purpose
Submit terminal completion report for one task.

## Required Arguments
One of:
- `task_report: <report_text>`
- `task_report_path: <report_file_path>`

## Optional Arguments
- `task_id: <task_id>` (uses active task context when omitted)

## Minimal Example
```json
{
  "task_id": "task-impl-01",
  "task_report_path": "docs/reports/task-impl-01_done.md"
}
```

## Backend Behavior
- Sent as `TASK_REPORT` with `report_mode=DONE`.
- Includes report content and optional report file path as artifact.

## Strong Validation
- `progress.md` must exist and contain concrete progress.
- Reported task must belong to current role/session.

## Common Errors
- `TASK_PROGRESS_REQUIRED`
- `TASK_RESULT_INVALID_TARGET`
- `TASK_REPORT_NO_STATE_CHANGE`

## Next Action on Failure
Use `next_action` from tool error JSON, fix evidence/ownership, then resend once.
