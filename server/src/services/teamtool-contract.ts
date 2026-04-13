export const TEAMTOOL_MCP_SERVER_KEY = "teamtool";

export const TEAM_TOOL_NAMES = [
  "task_create_assign",
  "task_report_in_progress",
  "task_report_done",
  "task_report_block",
  "discuss_request",
  "discuss_reply",
  "discuss_close",
  "route_targets_get",
  "lock_manage"
] as const;

export type TeamToolName = (typeof TEAM_TOOL_NAMES)[number];

export function buildCodexTeamToolAlias(name: string): string {
  return `mcp__${TEAMTOOL_MCP_SERVER_KEY}__${name}`;
}

export function formatTeamToolNameWithCodexAlias(name: string): string {
  return `\`${name}\` (Codex MCP alias: \`${buildCodexTeamToolAlias(name)}\`)`;
}

export function buildTeamToolAliasGuidance(): string {
  return "If your runtime exposes provider-prefixed MCP tool names, call the exact exposed name. In Codex CLI, TeamTool tools are exposed as `mcp__teamtool__<tool_name>`.";
}

export function formatTeamToolNamesWithCodexAliases(names: readonly string[]): string {
  return names.map((name) => formatTeamToolNameWithCodexAlias(name)).join(", ");
}

export function buildRouteTargetsGuidance(suffix: string): string {
  return `Call ${formatTeamToolNameWithCodexAlias("route_targets_get")} first, ${suffix}`;
}

export function buildTaskExistsNextAction(): string {
  return [
    "Do not recreate the same task_id.",
    "Inspect the existing task owner, parent, and state first.",
    "If the existing task can continue, continue or report on that task.",
    "Otherwise use discuss/report to resolve the conflict before retrying."
  ].join(" ");
}
