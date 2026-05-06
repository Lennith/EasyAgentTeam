import type { WorkflowDispatchPromptContext } from "./workflow-dispatch-prompt-context.js";
import {
  buildFocusTaskExecutionContractLines,
  buildProviderDispatchContractLines,
  buildTaskSubtreeContractLines
} from "../../prompt-contract.js";

function buildWorkflowExecutionContract(context: WorkflowDispatchPromptContext): string[] {
  const decompositionContract = context.isDecompositionPhase
    ? context.requiresExecutionSubtaskBeforeDone
      ? "This focus task is a decomposition phase and no execution subtask exists yet. Before reporting DONE, create at least one concrete non-manager execution subtask under this focus task."
      : "This focus task is a decomposition phase. Only create a new subtask if there is still an immediate execution gap that must be delegated from this phase."
    : "This focus task is not a decomposition phase. Do not call task_create_assign in this turn.";
  const contractLines = [
    "Execute immediately and produce concrete progress/artifacts.",
    "Shared deliverables must be written under TeamWorkSpace/docs/** or TeamWorkSpace/src/** (not only inside YourWorkspace).",
    "Use TeamTool task actions from the runtime tool registry only (task_create_assign / task_report_* / discuss_*).",
    "When task_assign_route_table is configured, task_create_assign must target an allowed owner role; self-assignment also requires an explicit self edge.",
    ...buildFocusTaskExecutionContractLines(),
    "If blocked, report BLOCKED_DEP with concrete blockers.",
    "On completion, report DONE for the phase task, not only subtasks.",
    ...buildTaskSubtreeContractLines(),
    ...buildProviderDispatchContractLines(context.providerId),
    decompositionContract,
    "The required execution subtask must use the focus task as parent_task_id and include explicit owner_role, dependencies, acceptance, and artifacts.",
    "For decomposition phases, only create immediate execution subtasks that can advance from the current phase inputs. Do not create QA/release subtasks that depend on future phase tasks.",
    "If the focus task is not explicitly a planning/decomposition task, execute directly on the focus task and report progress there. Do not delegate through new subtasks.",
    "Non-decomposition design/specification phases must hand off downstream work through shared artifacts and discuss messages, not by creating execution subtasks for later-phase owners.",
    "If the focus task is already a delegated execution subtask that you own, treat it as the execution unit. Do not create another self-owned child subtask underneath it."
  ];
  return contractLines.map((line, index) => `${index + 1}) ${line}`);
}

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
    ...buildWorkflowExecutionContract(context)
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}
