import type { ProjectRepositoryBundle } from "../../data/repository/project-repository-bundle.js";
import type {
  ManagerToAgentMessage,
  ProjectPaths,
  ProjectRecord,
  SessionRecord,
  TaskRecord
} from "../../domain/models.js";
import { sortTasksForDispatch } from "../orchestrator-dispatch-core.js";
import { buildTaskAssignmentMessageForTask } from "../task-actions/shared.js";
import { buildNormalizedDispatchSelectionResult } from "./shared/index.js";
import type { DispatchKind, DispatchProjectInput, SessionDispatchResult } from "./project-orchestrator-types.js";
import type { NormalizedDispatchSelectionResult, OrchestratorDispatchSelectionAdapter } from "./shared/contracts.js";
import {
  buildOrchestratorDuplicateTaskDispatchSkipResult,
  evaluateOrchestratorDispatchSessionAvailability
} from "./shared/dispatch-selection-support.js";
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
        selectedMessages = [buildTaskAssignmentMessageForTask(project, taskSelection.task)];
        selectedTaskId = taskSelection.task.taskId;
        dispatchKind = "task";
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
