import type { WorkflowDispatchPromptContext } from "./workflow-dispatch-prompt-context.js";
import {
  buildTeamToolAliasGuidance,
  formatTeamToolNameWithCodexAlias,
  formatTeamToolNamesWithCodexAliases
} from "../../teamtool-contract.js";

export function buildWorkflowDispatchPrompt(context: WorkflowDispatchPromptContext): string {
  const rolePrompt = context.rolePrompt?.trim() ?? "";
  return [
    `You are agent role '${context.role}' in workflow run '${context.run.runId}'.`,
    `TeamWorkSpace=${context.frame.teamWorkspace} (shared workflow root; final deliverables belong here).`,
    `YourWorkspace=${context.frame.yourWorkspace} (role-local working directory; do not keep final outputs only here).`,
    "Runtime mode: static team rules are in local AGENTS.md.",
    `Workflow objective: ${context.run.description ?? context.run.name}`,
    `Dispatch kind: ${context.dispatchKind}.`,
    `Assigned task id: ${context.taskId ?? "(none)"}`,
    `Current task state: ${context.taskState ?? "UNKNOWN"}`,
    `Focus task id (this turn): ${context.frame.focusTaskId ?? "(none)"}`,
    `This turn should operate on: ${context.frame.focusTaskId ?? "(none)"} (focus task first).`,
    `Visible actionable tasks (same role): ${context.frame.visibleActionableTasks.join(", ") || "(none)"}`,
    `Visible blocked tasks (same role): ${context.frame.visibleBlockedTasks.join(", ") || "(none)"}`,
    `Message type: ${context.messageType}`,
    context.messageContent ? `Message content:\n${context.messageContent}` : "Message content: (none)",
    context.taskSubtree
      ? `Task subtree context:\n- focus_task_id: ${context.taskSubtree.focus_task_id}\n- descendant_ids: ${context.taskSubtree.descendant_ids.join(", ") || "(none)"}\n- descendant_counts: total=${context.taskSubtree.descendant_counts.total}, unresolved=${context.taskSubtree.descendant_counts.unresolved}, done=${context.taskSubtree.descendant_counts.done}, blocked=${context.taskSubtree.descendant_counts.blocked}, canceled=${context.taskSubtree.descendant_counts.canceled}\n- unresolved_descendant_ids: ${context.taskSubtree.unresolved_descendant_ids.join(", ") || "(none)"}\n- terminal_descendant_reports: ${context.taskSubtree.terminal_descendant_reports.map((item) => `${item.task_id}=${item.state}`).join(", ") || "(none)"}`
      : "Task subtree context: (none)",
    context.task
      ? `Task context:\n- title: ${context.task.resolvedTitle}\n- owner: ${context.task.ownerRole}\n- parent: ${context.task.parentTaskId ?? "(none)"}\n- dependencies: ${(context.task.dependencies ?? []).join(", ") || "(none)"}\n- dependency_states: ${context.dependencyStatus}\n- dependencies_ready: ${context.frame.dependenciesReady ? "true" : "false"}\n- unresolved_dependencies: ${context.frame.unresolvedDependencies.join(", ") || "(none)"}\n- acceptance: ${(context.task.acceptance ?? []).join(" | ") || "(none)"}\n- artifacts: ${(context.task.artifacts ?? []).join(", ") || "(none)"}`
      : "Task context: (none)",
    rolePrompt ? `Role system prompt:\n${rolePrompt}` : "",
    "Execution contract:",
    "1) Execute immediately and produce concrete progress/artifacts.",
    "2) Shared deliverables must be written under TeamWorkSpace/docs/** or TeamWorkSpace/src/** (not only inside YourWorkspace).",
    "3) Use TeamTool task actions from the runtime tool registry only (task_create_assign / task_report_* / discuss_*).",
    "4) Focus task first: prioritize this-turn focus task over other visible tasks.",
    "5) Non-focus task report is allowed only when dependencies are already satisfied; treat it as non-preferred side work.",
    "6) Never report IN_PROGRESS/DONE for tasks whose dependencies are not ready.",
    "7) If report fails due to dependencies, wait for dependency completion signal/reminder and then retry; retract or downgrade conflicting premature completion claims to draft.",
    "8) If blocked, report BLOCKED_DEP with concrete blockers.",
    "9) On completion, report DONE for the phase task, not only subtasks.",
    "10) If task_subtree is present, treat it as the latest descendant convergence snapshot for the focus task.",
    "11) Use task_subtree to decide whether to wait on descendants or report new parent progress.",
    `12) Provider alias rule: ${buildTeamToolAliasGuidance()}`,
    `13) Task report tool calls are ${formatTeamToolNamesWithCodexAliases(["task_report_in_progress", "task_report_done", "task_report_block"])}.`,
    `14) Discuss tool calls are ${formatTeamToolNamesWithCodexAliases(["discuss_request", "discuss_reply", "discuss_close"])}.`,
    `15) Route discovery tool is ${formatTeamToolNameWithCodexAlias("route_targets_get")}.`,
    "16) Only call task_report_* for tasks owned by your role or created by your role.",
    "17) If task_create_assign returns TASK_EXISTS, do not retry the same create call. Inspect the existing task first and recover via next_action.",
    "18) If a TeamTool call fails, quote error_code and next_action, then recover from next_action. Do not describe the tool as unavailable."
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}
