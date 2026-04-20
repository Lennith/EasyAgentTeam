import type { ProjectRepositoryBundle } from "../../../data/repository/project/repository-bundle.js";
import type {
  ManagerToAgentMessage,
  ProjectPaths,
  ProjectRecord,
  SessionRecord,
  TaskRecord
} from "../../../domain/models.js";
import {
  extractTaskIdFromMessage,
  readMessageTypeUpper,
  sortTasksForDispatch
} from "../../orchestrator-dispatch-core.js";
import { buildTaskAssignmentMessageForTask } from "../../task-actions/shared.js";
import {
  buildNormalizedDispatchSelectionResult,
  buildOrchestratorTaskRedispatchSummary,
  buildOrchestratorTaskSubtreePayload
} from "../shared/index.js";
import type { DispatchKind, DispatchProjectInput, SessionDispatchResult } from "./project-orchestrator-types.js";
import type { NormalizedDispatchSelectionResult, OrchestratorDispatchSelectionAdapter } from "../shared/contracts.js";
import {
  buildOrchestratorDuplicateTaskDispatchSkipResult,
  evaluateOrchestratorDispatchSessionAvailability
} from "../shared/dispatch-selection-support.js";
import { resolveProjectTaskSelection } from "./project-dispatch-selection-task.js";
import { resolveProjectDispatchMessageSelection } from "./project-dispatch-selection-message.js";

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

function shouldRetryPreviouslyFailedMessageDispatch(
  session: SessionRecord,
  dispatchKind: DispatchKind,
  messageId: string,
  force: boolean
): boolean {
  if (force || dispatchKind !== "message") {
    return false;
  }
  if (session.lastInboxMessageId !== messageId) {
    return false;
  }
  return (
    session.status === "idle" && typeof session.lastFailureAt === "string" && session.lastFailureAt.trim().length > 0
  );
}

function isAutomaticTaskRedispatchSource(message: ManagerToAgentMessage, focusTaskId: string): boolean {
  const body = message.body as Record<string, unknown>;
  if ((extractTaskIdFromMessage(message) ?? "") !== focusTaskId) {
    return false;
  }
  const messageType = readMessageTypeUpper(message);
  if (messageType === "TASK_ASSIGNMENT" || messageType === "TASK_CREATOR_TERMINAL_REPORT") {
    return true;
  }
  return messageType === "MANAGER_MESSAGE" && typeof body.reminder === "object" && body.reminder !== null;
}

function buildSyntheticTaskDispatchMessage(
  project: ProjectRecord,
  task: TaskRecord,
  allTasks: TaskRecord[],
  sourceMessages: ManagerToAgentMessage[]
): ManagerToAgentMessage {
  const firstSourceMessage = sourceMessages[0];
  const taskSubtree = buildOrchestratorTaskSubtreePayload(
    task.taskId,
    allTasks.map((item) => ({
      taskId: item.taskId,
      parentTaskId: item.parentTaskId,
      state: item.state,
      ownerRole: item.ownerRole,
      ownerSession: item.ownerSession ?? null,
      closeReportId: item.closeReportId ?? null,
      lastSummary: item.lastSummary ?? null
    }))
  );
  return buildTaskAssignmentMessageForTask(project, task, {
    requestId: firstSourceMessage?.envelope.correlation.request_id,
    parentRequestId: firstSourceMessage?.envelope.correlation.parent_request_id,
    summary: buildOrchestratorTaskRedispatchSummary(task.state, taskSubtree, task.lastSummary),
    taskSubtree
  });
}

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
    const explicitMessageDispatch = Boolean(input.messageId?.trim());
    const inboxMessages = await this.repositories.inbox.listInboxMessages(paths, session.role);

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
    let selectedMessageIds: string[] = [];

    const messageSelection = resolveProjectDispatchMessageSelection({
      project,
      role: session.role,
      allTasks,
      runnableTasks: runnableByRole.tasks,
      inboxMessages,
      messageId: input.messageId,
      force: Boolean(input.force)
    });
    selectedMessages = messageSelection.selectedMessages;
    selectedTaskId = messageSelection.selectedTaskId;
    dispatchKind = messageSelection.dispatchKind;
    selectedTask = messageSelection.selectedTask;
    selectedMessageIds = selectedMessages.map((message) => message.envelope.message_id);

    if (selectedMessages.length === 0) {
      const taskSelection = await resolveProjectTaskSelection({
        repositories: this.repositories,
        project,
        paths,
        session,
        input,
        allTasks,
        prioritizedRunnableTasks,
        runnableTasks: runnableByRole.tasks
      });
      if (taskSelection.status === "skipped") {
        return taskSelection;
      }
      if (taskSelection.task) {
        selectedTask = taskSelection.task;
        selectedMessages = [buildSyntheticTaskDispatchMessage(project, taskSelection.task, allTasks, [])];
        selectedTaskId = taskSelection.task.taskId;
        dispatchKind = "task";
        selectedMessageIds = [];
      }
    } else if (!explicitMessageDispatch && selectedTask) {
      const focusTask = selectedTask;
      if (!selectedMessages.every((message) => isAutomaticTaskRedispatchSource(message, focusTask.taskId))) {
        selectedMessageIds = selectedMessages.map((message) => message.envelope.message_id);
      } else {
        const sourceMessages = selectedMessages;
        selectedMessages = [buildSyntheticTaskDispatchMessage(project, focusTask, allTasks, sourceMessages)];
        selectedTaskId = focusTask.taskId;
        dispatchKind = "task";
        selectedMessageIds = sourceMessages.map((message) => message.envelope.message_id);
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
    const retryingFailedMessage = shouldRetryPreviouslyFailedMessageDispatch(
      session,
      dispatchKind,
      firstMessage.envelope.message_id,
      Boolean(input.force)
    );
    if (
      !retryingFailedMessage &&
      !input.force &&
      dispatchKind === "message" &&
      session.lastInboxMessageId === firstMessage.envelope.message_id
    ) {
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
        ...buildNormalizedDispatchSelectionResult({
          role: session.role,
          session,
          dispatchKind,
          taskId: selectedTaskId || null,
          message: firstMessage ?? null,
          requestId: firstMessage?.envelope.correlation.request_id ?? null
        }),
        messages: selectedMessages,
        selectedMessageIds,
        task: selectedTask,
        allTasks
      }
    };
  }
}
