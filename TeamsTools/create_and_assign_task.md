# Tool: `task_create_assign`

## Purpose
Create one execution task and assign it to a target role in one step.

## Required Arguments
- `title: <task_title>`
- `to_role: <owner_role>`

## Optional Arguments
- `task_id: <task_id>`
- `parent_task_id: <parent_task_id>`
- `root_task_id: <root_task_id>`
- `priority: <integer>`
- `dependencies: <task_id_list>`
- `write_set: <project_relative_file_list>`
- `acceptance: <acceptance_criteria_list>`
- `artifacts: <artifact_path_list>`
- `content: <short_context>`

## Minimal Example
```json
{
  "title": "Implement task tree renderer",
  "to_role": "dev_impl",
  "dependencies": ["task-req-analysis"],
  "write_set": ["src/task-tree/renderer.ts"]
}
```

## Success Output
Returns created task metadata and backend task-action result.

## Common Errors
- `TASK_BINDING_REQUIRED`
- `TASK_ROUTE_DENIED`
- `TASK_DEPENDENCY_CYCLE`
- `TASK_DEPENDENCY_CROSS_ROOT`

## Next Action on Failure
Follow `next_action` in tool error JSON, fix payload, then retry once.
