import type { ProviderId } from "@autodev/agent-library";
import {
  TEAM_TOOL_NAMES,
  buildTeamToolAliasGuidance,
  formatTeamToolNameWithCodexAlias,
  formatTeamToolNamesWithCodexAliases
} from "./teamtool-contract.js";

export interface DiscussPromptPolicyLines {
  oneRequestPerDialogue: string;
  roundLimit: string;
  roundEscalation: string;
}

export function providerHasAuthoritativeSystemPrompt(providerId: ProviderId): boolean {
  return providerId === "minimax";
}

export function buildTeamToolCatalogLines(indent = ""): string[] {
  return TEAM_TOOL_NAMES.map((name) => `${indent}- ${formatTeamToolNameWithCodexAlias(name)}`);
}

export function buildTeamToolRegistryRules(): string[] {
  return [
    buildTeamToolAliasGuidance(),
    "TeamTool entries are model-callable tools, not shell commands, not local CLI commands, and not workspace files.",
    "Do not use Get-Command, which, file search, or MCP resource browsing to discover TeamTool. If the task needs TeamTool, call the exact exposed tool name directly.",
    "Shell output is never evidence that TeamTool is unavailable. Only an actual failed ToolCall result counts as unavailability evidence."
  ];
}

export function buildTaskProgressContractRules(): string[] {
  return [
    "A natural-language completion/blocker message without the corresponding ToolCall is invalid and will be treated as unfinished work; the corresponding task_report_* ToolCall is required.",
    "If the task is complete, call the exact task_report_done tool before writing any final summary. If that ToolCall fails, quote its returned error_code and next_action.",
    "Only call task_report_* for tasks owned by your role or created by your role.",
    "If task_create_assign returns TASK_EXISTS, do not retry the same create call. Inspect the existing task first and recover via next_action.",
    "If a TeamTool call fails, recover using next_action. Do not claim the tool is unavailable unless an actual ToolCall failed.",
    'If your session has an active task, write an initial ./progress.md entry and call task_report_in_progress({"content":"Started <task>","progress_file":"./progress.md"}) before long-running shell work, dependency downloads, full builds, or broad validation loops.',
    "Bound long-running external validation. If a build/test depends on missing SDKs, network downloads, or environment repair, record the blocker/risk in progress.md and report the task outcome instead of repeatedly changing environment/toolchain settings.",
    'Exact progress examples: task_report_in_progress({"content":"Started <task>","progress_file":"./progress.md"}) and task_report_done({"task_report_path":"./progress.md"}). If your runtime exposes Codex MCP aliases instead, use the matching mcp__teamtool__* exposed name.'
  ];
}

export function buildFocusTaskExecutionContractLines(): string[] {
  return [
    "Focus task first: prioritize this-turn focus task over other visible tasks.",
    "Non-focus task report is allowed only when dependencies are already satisfied; non-focus task reporting is allowed only when dependencies are already ready.",
    "Never report IN_PROGRESS/DONE for tasks whose dependencies are not ready; never report IN_PROGRESS/DONE for dependency-blocked tasks.",
    "If report fails due to dependencies, wait for dependency completion signal/reminder and then retry; retract or downgrade conflicting premature completion claims to draft."
  ];
}

export function buildTaskSubtreeContractLines(): string[] {
  return [
    "If task_subtree is present, treat it as the latest descendant convergence snapshot for the focus task.",
    "Use task_subtree to decide whether to wait on descendants or report new parent progress."
  ];
}

export function buildSystemRuntimeContractLines(discussPolicy: DiscussPromptPolicyLines): string[] {
  return [
    "1) Read `./AGENTS.md` first for runtime rules and team coordination.",
    "2) Deliverables must be file-based, not chat-only:",
    "   - TeamWorkSpace/docs/** for requirements/plans/reports",
    "   - TeamWorkSpace/src/** for implementation",
    "3) Team communication is manager-routed only; do not bypass with direct teammate chat.",
    "4) Team collaboration must use TeamTool tool calls from the runtime tool registry (not custom scripts):",
    ...buildTeamToolCatalogLines("   "),
    ...buildTeamToolRegistryRules().map((line, index) => `${index + 5}) ${line}`),
    ...buildTaskProgressContractRules().map((line, index) => `${index + 9}) ${line}`),
    "17) Discuss policy:",
    `   - ${discussPolicy.oneRequestPerDialogue}`,
    `   - ${discussPolicy.roundLimit}`,
    `   - ${discussPolicy.roundEscalation}`
  ];
}

export function buildAgentWorkspaceStartupChecklistLines(runtimeGuide: string): string[] {
  return [
    "## Startup Checklist",
    runtimeGuide,
    "1. Read `./role.md` for your role-specific objective and output contract.",
    "2. Read `../TEAM.md` to understand current team members.",
    "3. Use TeamTool built-in ToolCalls directly from the runtime tool registry:",
    ...buildTeamToolCatalogLines("   "),
    ...buildTeamToolRegistryRules().map((line, index) => `${index + 4}. ${line}`),
    "7. All $env values are set in your runtime."
  ];
}

export function buildAgentWorkspaceTaskProgressLines(): string[] {
  return [
    "## Task Progress Discipline (CRITICAL)",
    "- If you have an assigned task (taskId in your session), you MUST report progress via built-in ToolCalls: task_report_in_progress, task_report_done, task_report_block.",
    "- discuss_request/discuss_reply/discuss_close are for discuss flow only; they do NOT count as task progress.",
    "- Failure to report task progress will cause task to remain in 'granted' state indefinitely.",
    ...buildTaskProgressContractRules().map((line) => `- ${line}`)
  ];
}

function buildProviderHardDispatchContractLines(providerId: ProviderId): string[] {
  return [
    `Provider prompt policy: ${providerId} does not expose a reliably editable system prompt; this dispatch message repeats the minimum hard contract.`,
    `provider alias rule: ${buildTeamToolAliasGuidance()}`,
    "TeamTool names below are already present in your runtime tool registry.",
    "Do not probe TeamTool availability via Get-Command, which, script search, or MCP resource listing.",
    "If you need a TeamTool action, call the exact tool name directly.",
    "Shell output is never evidence that TeamTool is unavailable.",
    "A natural-language completion/blocker message without the corresponding task_report_* ToolCall is invalid.",
    "If the task is complete, call the exact task_report_done tool before writing any final summary.",
    "Only call task_report_* for tasks owned by your role or created by your role.",
    "If task_create_assign returns TASK_EXISTS, do not retry the same create call. Inspect the existing task first and recover via next_action.",
    "If a required ToolCall fails, quote the returned error_code and next_action instead of inventing a missing-tool explanation.",
    "Recover TeamTool failures using next_action. Do not describe the failure as tool unavailability.",
    'exact report examples: `mcp__teamtool__task_report_in_progress({"content":"Started <task>","progress_file":"./progress.md"})` and `mcp__teamtool__task_report_done({"task_report_path":"./progress.md"})`.',
    "if discuss is about task, read <YourWorkSpace>/progress.md and then use task_report_* ToolCalls when you make progress.",
    `discuss tool calls are ${formatTeamToolNamesWithCodexAliases(["discuss_request", "discuss_reply", "discuss_close"])} (discussion only, not progress).`,
    `task report tool calls are ${formatTeamToolNamesWithCodexAliases(["task_report_in_progress", "task_report_done", "task_report_block"])} (use these for progress/completion).`,
    `route discovery tool is ${formatTeamToolNameWithCodexAlias("route_targets_get")}.`
  ];
}

function buildProviderCompactDispatchContractLines(): string[] {
  return [
    "Provider prompt policy: stable TeamTool/report/focus rules are in the system prompt; this dispatch message carries only turn-specific context.",
    "Use task_report_* and discuss_* according to the system prompt contract.",
    "If a required TeamTool call fails, follow returned error_code and next_action from the system prompt contract."
  ];
}

export function buildProviderDispatchContractLines(providerId: ProviderId): string[] {
  return providerHasAuthoritativeSystemPrompt(providerId)
    ? buildProviderCompactDispatchContractLines()
    : buildProviderHardDispatchContractLines(providerId);
}
