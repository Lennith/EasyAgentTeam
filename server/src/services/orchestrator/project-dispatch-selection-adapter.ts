import { getRoleMessageStatus } from "../../data/role-message-status-store.js";
import type { ProjectRepositoryBundle } from "../../data/repository/project-repository-bundle.js";
import type {
  ManagerToAgentMessage,
  ProjectPaths,
  ProjectRecord,
  SessionRecord,
  TaskRecord
} from "../../domain/models.js";
import { extractTaskIdFromMessage, sortTasksForDispatch } from "../orchestrator-dispatch-core.js";
import { createOpaqueIdentifier } from "./shared/orchestrator-identifiers.js";
import { buildOrchestratorTaskAssignmentMessage, resolveOrchestratorDispatchCandidate } from "./shared/index.js";
import { areTaskDependenciesSatisfied, isForceDispatchableState } from "./project-dispatch-policy.js";
import type { DispatchKind, DispatchProjectInput, SessionDispatchResult } from "./project-orchestrator-types.js";
import type { NormalizedDispatchSelectionResult, OrchestratorDispatchSelectionAdapter } from "./shared/contracts.js";
import {
  buildOrchestratorDuplicateTaskDispatchSkipResult,
  evaluateOrchestratorDispatchSessionAvailability
} from "./shared/dispatch-selection-support.js";

export interface ProjectDispatchSelectionScope {
  project: ProjectRecord;
  paths: ProjectPaths;
  session: SessionRecord;
}

export interface ProjectDispatchSelection extends NormalizedDispatchSelectionResult<
  SessionRecord,
  ManagerToAgentMessage
> {
  messages: ManagerToAgentMessage[];
  selectedMessageIds: string[];
  task: TaskRecord | null;
  allTasks: TaskRecord[];
}

export type ProjectDispatchSelectionResult =
  | {
      status: "selected";
      selection: ProjectDispatchSelection;
    }
  | {
      status: "skipped";
      result: SessionDispatchResult;
    };

export class ProjectDispatchSelectionAdapter implements OrchestratorDispatchSelectionAdapter<
  ProjectDispatchSelectionScope,
  DispatchProjectInput,
  ProjectDispatchSelectionResult
> {
  constructor(private readonly repositories: ProjectRepositoryBundle) {}

  async select(
    scope: ProjectDispatchSelectionScope,
    input: DispatchProjectInput
  ): Promise<ProjectDispatchSelectionResult> {
    const { project, paths, session } = scope;
    const inboxMessages = await this.repositories.inbox.listInboxMessages(paths, session.role);
    const explicitMessageCandidate = input.messageId
      ? (inboxMessages.find((item) => item.envelope.message_id === input.messageId) ?? null)
      : null;
    const roleStatus = getRoleMessageStatus(project, session.role);
    const confirmedIds = new Set(roleStatus.confirmedMessageIds);
    const pendingIds = new Set(roleStatus.pendingConfirmedMessages.map((item) => item.messageId));
    const undeliveredMessages = input.messageId
      ? []
      : inboxMessages
          .filter((item) => !confirmedIds.has(item.envelope.message_id) && !pendingIds.has(item.envelope.message_id))
          .sort((a, b) => {
            const aTime = a.envelope.timestamp ? new Date(a.envelope.timestamp).getTime() : 0;
            const bTime = b.envelope.timestamp ? new Date(b.envelope.timestamp).getTime() : 0;
            return aTime - bTime;
          });

    const runnableGroups = await this.repositories.taskboard.listRunnableTasksByRole(paths, project.projectId);
    const runnableByRole = runnableGroups.find((item) => item.role === session.role) ?? {
      role: session.role,
      tasks: []
    };
    const allTasks = await this.repositories.taskboard.listTasks(paths, project.projectId);
    const prioritizedRunnableTasks = sortTasksForDispatch(runnableByRole.tasks, allTasks);

    let selectedMessages: ManagerToAgentMessage[] = [];
    let selectedTaskId = "";
    let dispatchKind: DispatchKind = null;
    let selectedTask: TaskRecord | null = null;

    if (explicitMessageCandidate) {
      selectedMessages = [explicitMessageCandidate];
      selectedTaskId = extractTaskIdFromMessage(explicitMessageCandidate) ?? "";
      dispatchKind = "message";
      selectedTask = selectedTaskId ? (allTasks.find((item) => item.taskId === selectedTaskId) ?? null) : null;
    } else {
      const messageCandidate = resolveOrchestratorDispatchCandidate({
        messages: undeliveredMessages,
        runnableTasks: runnableByRole.tasks,
        allTasks,
        force: Boolean(input.force),
        allowFallbackTask: false,
        resolveTaskById: (taskId) => allTasks.find((item) => item.taskId === taskId) ?? null
      });
      if (messageCandidate) {
        selectedMessages = messageCandidate.selectedMessages;
        selectedTaskId = messageCandidate.taskId ?? "";
        dispatchKind = messageCandidate.dispatchKind;
        selectedTask = messageCandidate.task;
      } else {
        const taskSelection = await this.resolveTaskSelection(
          scope,
          input,
          allTasks,
          prioritizedRunnableTasks,
          runnableByRole.tasks
        );
        if (taskSelection.status === "skipped") {
          return taskSelection;
        }
        if (taskSelection.task) {
          selectedTask = taskSelection.task;
          selectedMessages = [buildTaskAssignmentMessage(project, session, taskSelection.task)];
          selectedTaskId = taskSelection.task.taskId;
          dispatchKind = "task";
        }
      }
    }

    if (selectedMessages.length === 0) {
      return {
        status: "skipped",
        result: {
          sessionId: session.sessionId,
          role: session.role,
          outcome: input.messageId ? "message_not_found" : input.taskId ? "task_not_found" : "no_message",
          dispatchKind,
          messageId: input.messageId,
          taskId: input.taskId
        }
      };
    }

    const availability = evaluateOrchestratorDispatchSessionAvailability({
      sessionStatus: session.status,
      onlyIdle: Boolean(input.onlyIdle),
      force: Boolean(input.force),
      treatRunningAsBusy: false
    });
    if (!availability.available) {
      return {
        status: "skipped",
        result: {
          sessionId: session.sessionId,
          role: session.role,
          outcome: "session_busy",
          dispatchKind,
          reason: availability.reason ?? "session unavailable"
        }
      };
    }

    const firstMessage = selectedMessages[0];
    const selectedMessageIds = selectedMessages.map((message) => message.envelope.message_id);
    if (!input.force && dispatchKind === "message" && session.lastInboxMessageId === firstMessage.envelope.message_id) {
      return {
        status: "skipped",
        result: {
          sessionId: session.sessionId,
          role: session.role,
          outcome: "already_dispatched",
          dispatchKind,
          messageId: firstMessage.envelope.message_id,
          requestId: firstMessage.envelope.correlation.request_id
        }
      };
    }

    if (dispatchKind === "task" && selectedTaskId && !input.force) {
      const duplicateSkipResult = await buildOrchestratorDuplicateTaskDispatchSkipResult<SessionDispatchResult>({
        taskId: selectedTaskId,
        sessionId: session.sessionId,
        listEvents: async () => await this.repositories.events.listEvents(paths),
        onDuplicateDetected: async () => {
          await this.repositories.events.appendEvent(paths, {
            projectId: project.projectId,
            eventType: "ORCHESTRATOR_DISPATCH_SKIPPED",
            source: "manager",
            sessionId: session.sessionId,
            taskId: selectedTaskId,
            payload: {
              mode: input.mode,
              dispatchKind,
              messageIds: selectedMessageIds,
              requestId: firstMessage.envelope.correlation.request_id,
              dispatchSkipReason: "duplicate_open_dispatch"
            }
          });
        },
        buildSkippedResult: () => ({
          sessionId: session.sessionId,
          role: session.role,
          outcome: "already_dispatched",
          dispatchKind,
          messageId: firstMessage.envelope.message_id,
          requestId: firstMessage.envelope.correlation.request_id,
          taskId: selectedTaskId,
          reason: "duplicate_open_dispatch"
        })
      });
      if (duplicateSkipResult) {
        return {
          status: "skipped",
          result: duplicateSkipResult
        };
      }
    }

    return {
      status: "selected",
      selection: {
        role: session.role,
        session,
        dispatchKind,
        taskId: selectedTaskId || null,
        message: firstMessage ?? null,
        messageId: firstMessage?.envelope.message_id ?? null,
        requestId: firstMessage?.envelope.correlation.request_id ?? null,
        messages: selectedMessages,
        selectedMessageIds,
        task: selectedTask,
        allTasks,
        skipReason: undefined,
        terminalOutcome: undefined
      }
    };
  }

  private async resolveTaskSelection(
    scope: ProjectDispatchSelectionScope,
    input: DispatchProjectInput,
    allTasks: TaskRecord[],
    prioritizedRunnableTasks: TaskRecord[],
    runnableTasks: TaskRecord[]
  ): Promise<{ status: "selected"; task: TaskRecord | null } | { status: "skipped"; result: SessionDispatchResult }> {
    const { project, paths, session } = scope;
    let taskCandidate: TaskRecord | null = !input.force
      ? (prioritizedRunnableTasks.find((task) => task.state !== "MAY_BE_DONE") ?? null)
      : (prioritizedRunnableTasks[0] ?? null);

    if (!input.taskId) {
      return { status: "selected", task: taskCandidate };
    }

    const targetTask = allTasks.find((task) => task.taskId === input.taskId);
    if (!targetTask) {
      return {
        status: "skipped",
        result: {
          sessionId: session.sessionId,
          role: session.role,
          outcome: "task_not_found",
          dispatchKind: "task",
          taskId: input.taskId,
          reason: `task '${input.taskId}' does not exist (hint: refresh task-tree and retry with current task_id)`
        }
      };
    }
    if (targetTask.state === "DONE") {
      return {
        status: "skipped",
        result: {
          sessionId: session.sessionId,
          role: session.role,
          outcome: "task_already_done",
          dispatchKind: "task",
          taskId: input.taskId,
          reason: `task '${input.taskId}' is already DONE`
        }
      };
    }

    if (input.force) {
      if (!isForceDispatchableState(targetTask.state)) {
        return {
          status: "skipped",
          result: {
            sessionId: session.sessionId,
            role: session.role,
            outcome: "task_not_force_dispatchable",
            dispatchKind: "task",
            taskId: input.taskId,
            reason: `task '${input.taskId}' state=${targetTask.state} is not force-dispatchable`
          }
        };
      }
      if (session.role !== targetTask.ownerRole) {
        return {
          status: "skipped",
          result: {
            sessionId: session.sessionId,
            role: session.role,
            outcome: "task_owner_mismatch",
            dispatchKind: "task",
            taskId: input.taskId,
            reason: `task '${input.taskId}' belongs to role '${targetTask.ownerRole}', but session role is '${session.role}'`
          }
        };
      }
      taskCandidate = targetTask;
      return { status: "selected", task: taskCandidate };
    }

    const specifiedTask = runnableTasks.find((task) => task.taskId === input.taskId);
    if (!specifiedTask) {
      return {
        status: "skipped",
        result: {
          sessionId: session.sessionId,
          role: session.role,
          outcome: "task_not_found",
          dispatchKind: "task",
          taskId: input.taskId,
          reason: `task '${input.taskId}' is not runnable for session '${session.sessionId}'`
        }
      };
    }
    const dependencyGate = areTaskDependenciesSatisfied(specifiedTask, allTasks);
    if (!dependencyGate.satisfied) {
      await this.repositories.events.appendEvent(paths, {
        projectId: project.projectId,
        eventType: "ORCHESTRATOR_DISPATCH_SKIPPED",
        source: "manager",
        sessionId: session.sessionId,
        taskId: input.taskId,
        payload: {
          mode: input.mode,
          dispatchKind: "task",
          dispatchSkipReason: "dependency_gate_closed",
          unsatisfiedDependencyIds: dependencyGate.unsatisfiedDeps,
          blockingTaskIds: dependencyGate.blockingTaskIds
        }
      });
      return {
        status: "skipped",
        result: {
          sessionId: session.sessionId,
          role: session.role,
          outcome: "task_not_found",
          dispatchKind: "task",
          taskId: input.taskId,
          reason: `task '${input.taskId}' dependency gate is closed; unsatisfied_dependencies=[${dependencyGate.unsatisfiedDeps.join(", ")}], blocking_tasks=[${dependencyGate.blockingTaskIds.join(", ")}]`
        }
      };
    }
    taskCandidate = specifiedTask;
    return { status: "selected", task: taskCandidate };
  }
}

function buildTaskAssignmentMessage(
  project: ProjectRecord,
  session: SessionRecord,
  task: TaskRecord
): ManagerToAgentMessage {
  return buildOrchestratorTaskAssignmentMessage({
    scopeKind: "project",
    scopeId: project.projectId,
    messageId: createOpaqueIdentifier(),
    createdAt: new Date().toISOString(),
    senderType: "system",
    senderRole: "manager",
    senderSessionId: "manager-system",
    intent: "TASK_ASSIGNMENT",
    requestId: createOpaqueIdentifier(),
    taskId: task.taskId,
    ownerRole: session.role,
    reportToRole: "manager",
    reportToSessionId: "manager-system",
    expect: "TASK_REPORT",
    assignmentTaskId: task.taskId,
    title: task.title,
    summary: task.lastSummary ?? "",
    task: {
      taskId: task.taskId,
      taskKind: task.taskKind,
      parentTaskId: task.parentTaskId,
      rootTaskId: task.rootTaskId,
      state: task.state,
      ownerRole: task.ownerRole,
      ownerSession: task.ownerSession ?? null,
      priority: task.priority ?? 0,
      writeSet: task.writeSet,
      dependencies: task.dependencies,
      acceptance: task.acceptance,
      artifacts: task.artifacts
    }
  }) as ManagerToAgentMessage;
}
