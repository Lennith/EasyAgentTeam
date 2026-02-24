# Tool: `task_report_block`

## Purpose
Submit terminal blocked report for one task when execution cannot continue.

## Required Arguments
- `block_reason: <specific_blocker_and_required_input>`

## Optional Arguments
- `task_id: <task_id>` (uses active task context when omitted)
- `progress_file: <progress_file_path>`

## Minimal Example
```json
{
  "task_id": "task-api-migration",
  "block_reason": "Missing API credential for staging endpoint.",
  "progress_file": "Agents/dev_impl/progress.md"
}
```

## Backend Behavior
- Sent as `TASK_REPORT` with `results[].outcome=BLOCKED_DEP`.
- Task transitions to blocked state if validation passes.

## Strong Validation
- `progress.md` evidence is required for terminal reports.
- Reported task must be authorized for current role (owner role or creator role).

## Common Errors
- `TASK_PROGRESS_REQUIRED`
- `TASK_RESULT_INVALID_TARGET`

## Next Action on Failure
Follow `next_action` in tool error JSON, update progress evidence, then retry once.
