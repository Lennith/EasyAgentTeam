# Tool: `route_targets_get`

## Purpose
List route-allowed target roles and discuss round limits.

## Optional Arguments
- `from_agent: <current_role>`

If omitted, backend uses current runtime role.

## Minimal Example
```json
{
  "from_agent": "dev_impl"
}
```

## Output
- `allowedTargets[]` with:
  - `agentId`
  - `maxDiscussRounds`
- `hasExplicitRouteTable`

Use this before discuss/task delegation when route uncertainty exists.
