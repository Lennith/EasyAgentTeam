# TeamTools List (MiniMax ToolCall VNext)

Team collaboration in MiniMax must use built-in ToolCalls, not custom `.ps1` wrappers.

## Quick Rules
- Always bind actions to a task (`task_id` or active task context).
- Report progress continuously: `task_report_in_progress`.
- End each task with exactly one terminal report: `task_report_done` or `task_report_block`.
- Discuss unresolved points with `discuss_*` tools.
- Lock before editing shared files with `lock_manage`.

## Tool Index
- `task_create_assign`
  - Use: create task and assign owner in one call.
  - Required args: `title: <task_title>`, `to_role: <owner_role>`
  - Optional args: `task_id: <task_id>`, `parent_task_id: <parent_task_id>`, `root_task_id: <root_task_id>`, `priority: <integer>`, `dependencies: <task_id_list>`, `write_set: <project_relative_file_list>`, `acceptance: <acceptance_criteria_list>`, `artifacts: <artifact_path_list>`, `content: <short_context>`
  - Doc: `create_and_assign_task.md`

- `task_report_in_progress`
  - Use: non-terminal progress update (`IN_PROGRESS` / partial).
  - Required args: `content: <one_paragraph_progress_summary>`
  - Optional args: `task_id: <task_id>`, `progress_file: <progress_file_path>`
  - Doc: `report_in_progress.md`

- `task_report_done`
  - Use: terminal done report.
  - Required args: `task_report: <report_text>` or `task_report_path: <report_file_path>`
  - Optional args: `task_id: <task_id>`
  - Doc: `report_task_done.md`

- `task_report_block`
  - Use: terminal blocked report with actionable blocker.
  - Required args: `block_reason: <specific_blocker_and_required_input>`
  - Optional args: `task_id: <task_id>`, `progress_file: <progress_file_path>`
  - Doc: `report_task_block.md`

- `discuss_request`
  - Use: ask clarification or dependency question.
  - Required args: `to_role: <target_role>`, `message: <request_message>`
  - Optional args: `task_id: <task_id>`, `thread_id: <thread_id>`, `round: <positive_integer>`
  - Doc: `discuss_request.md`

- `discuss_reply`
  - Use: respond in discuss thread.
  - Required args: `to_role: <target_role>`, `message: <reply_message>`, `thread_id: <thread_id>`
  - Optional args: `task_id: <task_id>`, `round: <positive_integer>`, `in_reply_to: <message_or_request_id>`
  - Doc: `discuss_reply.md`

- `discuss_close`
  - Use: close discuss thread with final assumption/decision.
  - Required args: `to_role: <target_role>`, `message: <close_summary>`, `thread_id: <thread_id>`
  - Optional args: `task_id: <task_id>`, `round: <positive_integer>`
  - Doc: `discuss_close.md`

- `route_targets_get`
  - Use: query allowed route targets and round limits.
  - Optional args: `from_agent: <current_role>`
  - Doc: `get_route_targets.md`

- `lock_manage`
  - Use: acquire / renew / release / list file locks.
  - Required args: `action: <acquire|renew|release|list>`
  - Optional args: `lock_key: <project_relative_path>`, `target_type: <file|dir>`, `ttl_seconds: <integer>`, `purpose: <short_purpose>`
  - Doc: `lock.md`

## Error Contract
Every tool failure returns JSON with:
- `error_code`
- `message`
- `next_action`
- `raw`
