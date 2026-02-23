# Tool: `lock_manage`

## Purpose
Manage file locks in shared workspace.

## Required Arguments
- `action: <acquire|renew|release|list>`

## Optional Arguments
- `lock_key: <project_relative_path>` (required for acquire/renew/release)
- `target_type: <file|dir>` (optional for acquire)
- `ttl_seconds: <integer>` (optional for acquire; default backend value)
- `purpose: <short_purpose>` (optional for acquire)

## Minimal Examples

Acquire:
```json
{
  "action": "acquire",
  "lock_key": "src/task-tree/renderer.ts",
  "target_type": "file",
  "ttl_seconds": 300,
  "purpose": "implement dependency edge rendering"
}
```

Release:
```json
{
  "action": "release",
  "lock_key": "src/task-tree/renderer.ts"
}
```

## Common Errors
- `LOCK_KEY_REQUIRED`
- `LOCK_ACQUIRE_FAILED`
- `LOCK_NOT_OWNER`
- `LOCK_NOT_FOUND`

## Next Action on Failure
Read `next_action` from tool error JSON and resolve lock ownership/expiry before retry.
