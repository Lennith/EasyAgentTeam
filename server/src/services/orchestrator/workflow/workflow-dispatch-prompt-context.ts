import type {
  TaskSubtreePayload,
  WorkflowManagerToAgentMessage,
  WorkflowRunRecord,
  WorkflowTaskRuntimeRecord,
  WorkflowTaskState
} from "../../../domain/models.js";
import { readMessageTypeUpper } from "../../orchestrator-dispatch-core.js";
import type { OrchestratorPromptFrame, OrchestratorPromptFrameBuilder } from "../shared/contracts.js";
import { buildOrchestratorAgentWorkspaceDir } from "../shared/orchestrator-runtime-helpers.js";
import {
  createOrchestratorPromptFrame,
  DEFAULT_ORCHESTRATOR_EXECUTION_CONTRACT_LINES
} from "../shared/prompt-frame.js";

export interface WorkflowDispatchPromptContext {
  frame: OrchestratorPromptFrame;
  run: WorkflowRunRecord;
  role: string;
  taskId: string | null;
  dispatchKind: "task" | "message";
  message: WorkflowManagerToAgentMessage | null;
  messageType: string;
  messageContent: string;
  taskSubtree: TaskSubtreePayload | null;
  taskState: WorkflowTaskState | null;
  task: WorkflowRunRecord["tasks"][number] | null;
  dependencyStatus: string;
  rolePrompt?: string;
}

export interface BuildWorkflowDispatchPromptContextInput {
  run: WorkflowRunRecord;
  role: string;
  taskId: string | null;
  dispatchKind: "task" | "message";
  message: WorkflowManagerToAgentMessage | null;
  taskState: WorkflowTaskState | null;
  runtimeTasks: WorkflowTaskRuntimeRecord[];
  rolePrompt?: string;
}

class WorkflowDispatchPromptFrameBuilder implements OrchestratorPromptFrameBuilder<BuildWorkflowDispatchPromptContextInput> {
  buildFrame(input: BuildWorkflowDispatchPromptContextInput): OrchestratorPromptFrame {
    const task = input.taskId ? (input.run.tasks.find((item) => item.taskId === input.taskId) ?? null) : null;
    const runtimeById = new Map(input.runtimeTasks.map((item) => [item.taskId, item]));
    const runTaskById = new Map(input.run.tasks.map((item) => [item.taskId, item]));
    const focusDependencyIds = task?.dependencies ?? [];
    const unresolvedDependencies = focusDependencyIds.filter((dependencyTaskId) => {
      const dependencyTask = runtimeById.get(dependencyTaskId);
      return !dependencyTask || (dependencyTask.state !== "DONE" && dependencyTask.state !== "CANCELED");
    });
    const visibleRoleTasks = input.runtimeTasks
      .map((runtimeTask) => ({ runtimeTask, definition: runTaskById.get(runtimeTask.taskId) }))
      .filter((item) => item.definition?.ownerRole === input.role);
    return createOrchestratorPromptFrame({
      scopeKind: "workflow",
      scopeId: input.run.runId,
      role: input.role,
      sessionId: null,
      teamWorkspace: input.run.workspacePath,
      yourWorkspace: buildOrchestratorAgentWorkspaceDir(input.run.workspacePath, input.role),
      focusTaskId: input.taskId,
      visibleActionableTasks: visibleRoleTasks
        .filter(
          (item) =>
            item.runtimeTask.state === "READY" ||
            item.runtimeTask.state === "DISPATCHED" ||
            item.runtimeTask.state === "IN_PROGRESS" ||
            item.runtimeTask.state === "MAY_BE_DONE"
        )
        .map((item) => `${item.runtimeTask.taskId}(${item.runtimeTask.state})`),
      visibleBlockedTasks: visibleRoleTasks
        .filter((item) => item.runtimeTask.state === "BLOCKED_DEP")
        .map(
          (item) =>
            `${item.runtimeTask.taskId}(blocked_by=${(item.runtimeTask.blockedBy ?? []).join("|") || "unknown"})`
        ),
      dependenciesReady: unresolvedDependencies.length === 0,
      unresolvedDependencies,
      executionContractLines: [
        ...DEFAULT_ORCHESTRATOR_EXECUTION_CONTRACT_LINES,
        "If blocked, report BLOCKED_DEP with concrete blockers.",
        "On completion, report DONE for the phase task, not only subtasks."
      ]
    });
  }
}

const defaultWorkflowDispatchPromptFrameBuilder = new WorkflowDispatchPromptFrameBuilder();

export function buildWorkflowDispatchPromptContext(
  input: BuildWorkflowDispatchPromptContextInput
): WorkflowDispatchPromptContext {
  const frame = defaultWorkflowDispatchPromptFrameBuilder.buildFrame(input);
  const task = input.taskId ? (input.run.tasks.find((item) => item.taskId === input.taskId) ?? null) : null;
  const runtimeById = new Map(input.runtimeTasks.map((item) => [item.taskId, item]));
  const focusDependencyIds = task?.dependencies ?? [];
  const dependencyStatus =
    focusDependencyIds.length > 0
      ? focusDependencyIds
          .map((dependencyTaskId) => `${dependencyTaskId}=${runtimeById.get(dependencyTaskId)?.state ?? "UNKNOWN"}`)
          .join(", ")
      : "(none)";
  const messageType = input.message ? readMessageTypeUpper(input.message) : "TASK_ASSIGNMENT";
  const messageContent =
    input.message && typeof (input.message.body as Record<string, unknown>).content === "string"
      ? String((input.message.body as Record<string, unknown>).content)
      : "";
  const taskSubtreeRaw = input.message ? (input.message.body as Record<string, unknown>).task_subtree : null;
  return {
    frame,
    run: input.run,
    role: input.role,
    taskId: input.taskId,
    dispatchKind: input.dispatchKind,
    message: input.message,
    messageType,
    messageContent,
    taskSubtree:
      typeof taskSubtreeRaw === "object" && taskSubtreeRaw !== null ? (taskSubtreeRaw as TaskSubtreePayload) : null,
    taskState: input.taskState,
    task,
    dependencyStatus,
    rolePrompt: input.rolePrompt
  };
}
