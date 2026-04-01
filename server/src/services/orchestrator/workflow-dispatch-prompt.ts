import type { WorkflowDispatchPromptContext } from "./workflow-dispatch-prompt-context.js";

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
    context.task
      ? `Task context:\n- title: ${context.task.resolvedTitle}\n- owner: ${context.task.ownerRole}\n- parent: ${context.task.parentTaskId ?? "(none)"}\n- dependencies: ${(context.task.dependencies ?? []).join(", ") || "(none)"}\n- dependency_states: ${context.dependencyStatus}\n- dependencies_ready: ${context.frame.dependenciesReady ? "true" : "false"}\n- unresolved_dependencies: ${context.frame.unresolvedDependencies.join(", ") || "(none)"}\n- acceptance: ${(context.task.acceptance ?? []).join(" | ") || "(none)"}\n- artifacts: ${(context.task.artifacts ?? []).join(", ") || "(none)"}`
      : "Task context: (none)",
    rolePrompt ? `Role system prompt:\n${rolePrompt}` : "",
    "Execution contract:",
    "1) Execute immediately and produce concrete progress/artifacts.",
    "2) Shared deliverables must be written under TeamWorkSpace/docs/** or TeamWorkSpace/src/** (not only inside YourWorkspace).",
    "3) Use workflow task actions via manager APIs only (TASK_CREATE/TASK_DISCUSS_*/TASK_REPORT).",
    "4) Focus task first: prioritize this-turn focus task over other visible tasks.",
    "5) Non-focus task report is allowed only when dependencies are already satisfied; treat it as non-preferred side work.",
    "6) Never report IN_PROGRESS/DONE/MAY_BE_DONE for tasks whose dependencies are not ready.",
    "7) If report fails due to dependencies, wait for dependency completion signal/reminder and then retry; retract or downgrade conflicting premature completion claims to draft.",
    "8) If blocked, report BLOCKED_DEP with concrete blockers.",
    "9) On completion, report DONE for the phase task, not only subtasks."
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}
