import type { ManagerToAgentMessage, ProjectRecord, SessionRecord, TaskRecord } from "../../domain/models.js";
import type { ProjectRoutingSnapshot } from "../project-routing-snapshot-service.js";
import type { OrchestratorPromptFrame, OrchestratorPromptFrameBuilder } from "./shared/contracts.js";
import { createOrchestratorPromptFrame, DEFAULT_ORCHESTRATOR_EXECUTION_CONTRACT_LINES } from "./shared/prompt-frame.js";

export interface ProjectDispatchPromptContext {
  frame: OrchestratorPromptFrame;
  project: ProjectRecord;
  session: SessionRecord;
  taskId: string | null;
  messages: ManagerToAgentMessage[];
  routingSnapshot: ProjectRoutingSnapshot;
  focusTask: TaskRecord | null;
}

export interface BuildProjectDispatchPromptContextInput {
  project: ProjectRecord;
  session: SessionRecord;
  taskId: string | null;
  messages: ManagerToAgentMessage[];
  routingSnapshot: ProjectRoutingSnapshot;
  allTasks: TaskRecord[];
}

class ProjectDispatchPromptFrameBuilder implements OrchestratorPromptFrameBuilder<BuildProjectDispatchPromptContextInput> {
  buildFrame(input: BuildProjectDispatchPromptContextInput): OrchestratorPromptFrame {
    const taskById = new Map(input.allTasks.map((item) => [item.taskId, item]));
    const focusTask = input.taskId ? (taskById.get(input.taskId) ?? null) : null;
    const unresolvedDependencies =
      focusTask?.dependencies?.filter((dependencyTaskId) => {
        const dependencyTask = taskById.get(dependencyTaskId);
        return !dependencyTask || (dependencyTask.state !== "DONE" && dependencyTask.state !== "CANCELED");
      }) ?? [];
    const visibleRoleTasks = input.allTasks.filter((item) => item.ownerRole === input.session.role);
    return createOrchestratorPromptFrame({
      scopeKind: "project",
      scopeId: input.project.projectId,
      role: input.session.role,
      sessionId: input.session.sessionId,
      teamWorkspace: input.project.workspacePath,
      yourWorkspace: input.session.role
        ? `${input.project.workspacePath}/Agents/${input.session.role}`
        : input.project.workspacePath,
      focusTaskId: focusTask?.taskId ?? input.taskId ?? null,
      visibleActionableTasks: visibleRoleTasks
        .filter(
          (item) =>
            item.state === "READY" ||
            item.state === "DISPATCHED" ||
            item.state === "IN_PROGRESS" ||
            item.state === "MAY_BE_DONE"
        )
        .map((item) => `${item.taskId}(${item.state})`),
      visibleBlockedTasks: visibleRoleTasks
        .filter((item) => item.state === "BLOCKED_DEP")
        .map((item) => `${item.taskId}(blocked_by=${(item.dependencies ?? []).join("|") || "unknown"})`),
      dependenciesReady: unresolvedDependencies.length === 0,
      unresolvedDependencies,
      executionContractLines: [...DEFAULT_ORCHESTRATOR_EXECUTION_CONTRACT_LINES]
    });
  }
}

const defaultProjectDispatchPromptFrameBuilder = new ProjectDispatchPromptFrameBuilder();

export function buildProjectDispatchPromptContext(
  input: BuildProjectDispatchPromptContextInput
): ProjectDispatchPromptContext {
  const frame = defaultProjectDispatchPromptFrameBuilder.buildFrame(input);
  const focusTask = frame.focusTaskId
    ? (input.allTasks.find((item) => item.taskId === frame.focusTaskId) ?? null)
    : null;
  return {
    frame,
    project: input.project,
    session: input.session,
    taskId: input.taskId,
    messages: input.messages,
    routingSnapshot: input.routingSnapshot,
    focusTask
  };
}
