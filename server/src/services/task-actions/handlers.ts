import type { TaskActionHandler } from "./types.js";
import { TaskActionError } from "./types.js";
import type { TaskPatchInput } from "../../data/taskboard-store.js";
import { isProjectRouteAllowed, isTaskAssignRouteAllowed } from "../../data/project-store.js";
import {
  getTask,
  listTasks,
  patchTask,
  recomputeRunnableStates,
  createTask,
  updateTaskboardFromTaskReport
} from "../../data/taskboard-store.js";
import { getSession } from "../../data/session-store.js";
import { appendEvent } from "../../data/event-store.js";
import {
  routeProjectManagerMessage,
  routeProjectTaskAssignmentMessage
} from "../orchestrator/project-message-routing-service.js";
import { validateAgentProgressFile, TaskProgressValidationError } from "../task-progress-validation-service.js";
import { emitCreatorTerminalReportsIfReady } from "../task-creator-terminal-report-service.js";
import {
  buildDependencyNotReadyHint,
  buildTaskAssignmentMessageForTask,
  isAllowedTaskReportTransition,
  mergeDependencies,
  normalizeTaskReport,
  requiresOrchestratorReadyDependencies,
  readNumber,
  readString,
  readStringList,
  resolveTargetSession,
  resolveUnreadyDependencyTaskIds,
  type TaskReportRejectedResult
} from "./shared.js";
import { runTaskActionWriteContext } from "./write-context.js";

export const createTaskActionHandler: TaskActionHandler = {
  actionTypes: ["TASK_CREATE"],
  async handle(context) {
    const { dataRoot, project, paths, actionInput, requestId, fromAgent, fromSessionId, toRole, toSessionId } = context;
    return runTaskActionWriteContext(dataRoot, { project, paths }, async () => {
      const taskId = readString(actionInput.task_id) ?? readString(actionInput.taskId);
      const title = readString(actionInput.title);
      const ownerRole = readString(actionInput.owner_role) ?? readString(actionInput.ownerRole) ?? toRole;
      const parentTaskId = readString(actionInput.parent_task_id) ?? readString(actionInput.parentTaskId);
      const taskKind = (readString(actionInput.task_kind) ?? readString(actionInput.taskKind)) as
        | "PROJECT_ROOT"
        | "USER_ROOT"
        | "EXECUTION"
        | undefined;
      if (!taskId || !title || !ownerRole || (!parentTaskId && taskKind !== "PROJECT_ROOT")) {
        throw new TaskActionError(
          "TASK_CREATE requires task_id, title, parent_task_id, owner_role",
          "TASK_BINDING_REQUIRED",
          400
        );
      }
      if (!isTaskAssignRouteAllowed(project, fromAgent, ownerRole)) {
        throw new TaskActionError("task assign route denied", "TASK_ROUTE_DENIED");
      }
      const ownerSession = await resolveTargetSession(dataRoot, project, paths, ownerRole, toSessionId);
      const explicitDependencies = readStringList(actionInput.dependencies);
      const parentTask = parentTaskId ? await getTask(paths, project.projectId, parentTaskId).catch(() => null) : null;
      const inheritedDependencies = parentTask?.dependencies ?? [];
      const effectiveDependencies = mergeDependencies(inheritedDependencies, explicitDependencies);
      const created = await createTask(paths, project.projectId, {
        taskId,
        taskKind: taskKind as any,
        parentTaskId,
        rootTaskId: readString(actionInput.root_task_id) ?? readString(actionInput.rootTaskId),
        title,
        creatorRole: fromAgent,
        creatorSessionId: fromSessionId,
        ownerRole,
        ownerSession,
        priority: Number(actionInput.priority ?? 0),
        dependencies: effectiveDependencies,
        writeSet: readStringList(actionInput.write_set ?? actionInput.writeSet),
        acceptance: readStringList(actionInput.acceptance),
        artifacts: readStringList(actionInput.artifacts),
        state: "PLANNED"
      });
      await recomputeRunnableStates(paths, project.projectId);
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "TASK_CREATED",
        source: "manager",
        sessionId: fromSessionId,
        taskId: created.taskId,
        payload: {
          requestId,
          ownerRole: created.ownerRole,
          ownerSession: created.ownerSession ?? null
        }
      });
      if (created.ownerSession && created.taskKind !== "PROJECT_ROOT" && created.taskKind !== "USER_ROOT") {
        const taskMessage = buildTaskAssignmentMessageForTask(project, {
          taskId: created.taskId,
          taskKind: created.taskKind,
          parentTaskId: created.parentTaskId,
          rootTaskId: created.rootTaskId,
          title: created.title,
          state: created.state,
          ownerRole: created.ownerRole,
          ownerSession: created.ownerSession,
          priority: created.priority,
          writeSet: created.writeSet,
          dependencies: created.dependencies,
          acceptance: created.acceptance,
          artifacts: created.artifacts,
          lastSummary: created.lastSummary
        });
        await routeProjectTaskAssignmentMessage({
          dataRoot,
          project,
          paths,
          fromAgent,
          fromSessionId,
          requestId,
          taskId: created.taskId,
          toRole: created.ownerRole,
          toSessionId: created.ownerSession,
          message: taskMessage
        });
      }
      return {
        success: true,
        requestId,
        actionType: "TASK_CREATE",
        taskId: created.taskId
      };
    });
  }
};

export const updateTaskActionHandler: TaskActionHandler = {
  actionTypes: ["TASK_UPDATE"],
  async handle(context) {
    const { dataRoot, project, paths, actionInput, requestId, fromSessionId, defaultTaskId } = context;
    return runTaskActionWriteContext(dataRoot, { project, paths }, async () => {
      const taskId = readString(actionInput.task_id) ?? readString(actionInput.taskId) ?? defaultTaskId;
      if (!taskId) {
        throw new TaskActionError("TASK_UPDATE requires task_id", "TASK_BINDING_REQUIRED", 400);
      }
      const existing = await getTask(paths, project.projectId, taskId);
      if (!existing) {
        throw new TaskActionError(`task '${taskId}' not found`, "TASK_NOT_FOUND", 404);
      }
      const patch: TaskPatchInput = {};
      if (Object.prototype.hasOwnProperty.call(actionInput, "title")) {
        patch.title = readString(actionInput.title) ?? undefined;
      }
      if (Object.prototype.hasOwnProperty.call(actionInput, "dependencies")) {
        patch.dependencies = readStringList(actionInput.dependencies);
      }
      if (
        Object.prototype.hasOwnProperty.call(actionInput, "write_set") ||
        Object.prototype.hasOwnProperty.call(actionInput, "writeSet")
      ) {
        patch.writeSet = readStringList(actionInput.write_set ?? actionInput.writeSet);
      }
      if (Object.prototype.hasOwnProperty.call(actionInput, "acceptance")) {
        patch.acceptance = readStringList(actionInput.acceptance);
      }
      if (Object.prototype.hasOwnProperty.call(actionInput, "artifacts")) {
        patch.artifacts = readStringList(actionInput.artifacts);
      }
      if (Object.prototype.hasOwnProperty.call(actionInput, "priority")) {
        const priority = Number(actionInput.priority);
        if (Number.isFinite(priority)) {
          patch.priority = Math.floor(priority);
        }
      }
      if (Object.prototype.hasOwnProperty.call(actionInput, "alert")) {
        patch.alert = readString(actionInput.alert) ?? null;
      }
      const patched = await patchTask(paths, project.projectId, taskId, patch);
      await recomputeRunnableStates(paths, project.projectId);
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "TASK_UPDATED",
        source: "manager",
        sessionId: fromSessionId,
        taskId: patched.task.taskId,
        payload: {
          requestId,
          updates: patch
        }
      });
      return {
        success: true,
        requestId,
        actionType: "TASK_UPDATE",
        taskId: patched.task.taskId
      };
    });
  }
};

export const assignTaskActionHandler: TaskActionHandler = {
  actionTypes: ["TASK_ASSIGN"],
  async handle(context) {
    const {
      dataRoot,
      project,
      paths,
      actionInput,
      requestId,
      fromAgent,
      fromSessionId,
      toRole,
      toSessionId,
      defaultTaskId
    } = context;
    return runTaskActionWriteContext(dataRoot, { project, paths }, async () => {
      const taskId = readString(actionInput.task_id) ?? readString(actionInput.taskId) ?? defaultTaskId;
      const ownerRole = readString(actionInput.owner_role) ?? readString(actionInput.ownerRole) ?? toRole;
      if (!taskId || !ownerRole) {
        throw new TaskActionError("TASK_ASSIGN requires task_id and owner_role", "TASK_BINDING_REQUIRED", 400);
      }
      if (!isTaskAssignRouteAllowed(project, fromAgent, ownerRole)) {
        throw new TaskActionError("task assign route denied", "TASK_ROUTE_DENIED");
      }
      const ownerSession = await resolveTargetSession(dataRoot, project, paths, ownerRole, toSessionId);
      const dependenciesProvided = Object.prototype.hasOwnProperty.call(actionInput, "dependencies");
      const patched = await patchTask(paths, project.projectId, taskId, {
        ownerRole,
        ownerSession,
        dependencies: dependenciesProvided ? readStringList(actionInput.dependencies) : undefined,
        priority: Number(actionInput.priority ?? Number.NaN),
        state: "PLANNED"
      });
      await recomputeRunnableStates(paths, project.projectId);
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "TASK_ASSIGN_UPDATED",
        source: "manager",
        sessionId: fromSessionId,
        taskId: patched.task.taskId,
        payload: {
          requestId,
          ownerRole: patched.task.ownerRole,
          ownerSession: patched.task.ownerSession ?? null
        }
      });
      if (
        patched.task.ownerSession &&
        patched.task.taskKind !== "PROJECT_ROOT" &&
        patched.task.taskKind !== "USER_ROOT"
      ) {
        const taskMessage = buildTaskAssignmentMessageForTask(project, {
          taskId: patched.task.taskId,
          taskKind: patched.task.taskKind,
          parentTaskId: patched.task.parentTaskId,
          rootTaskId: patched.task.rootTaskId,
          title: patched.task.title,
          state: patched.task.state,
          ownerRole: patched.task.ownerRole,
          ownerSession: patched.task.ownerSession,
          priority: patched.task.priority,
          writeSet: patched.task.writeSet,
          dependencies: patched.task.dependencies,
          acceptance: patched.task.acceptance,
          artifacts: patched.task.artifacts,
          lastSummary: patched.task.lastSummary
        });
        await routeProjectTaskAssignmentMessage({
          dataRoot,
          project,
          paths,
          fromAgent,
          fromSessionId,
          requestId,
          taskId: patched.task.taskId,
          toRole: patched.task.ownerRole,
          toSessionId: patched.task.ownerSession,
          message: taskMessage
        });
      }
      return {
        success: true,
        requestId,
        actionType: "TASK_ASSIGN",
        taskId: patched.task.taskId
      };
    });
  }
};

export const discussTaskActionHandler: TaskActionHandler = {
  actionTypes: ["TASK_DISCUSS_REQUEST", "TASK_DISCUSS_REPLY", "TASK_DISCUSS_CLOSED"],
  async handle(context) {
    const {
      dataRoot,
      project,
      paths,
      actionType,
      actionInput,
      requestId,
      fromAgent,
      fromSessionId,
      toRole,
      toSessionId,
      defaultTaskId
    } = context;
    if (!toRole && !toSessionId) {
      throw new TaskActionError("task discuss target is required", "TASK_BINDING_REQUIRED", 400);
    }
    const resolvedToSessionEntry = toSessionId ? await getSession(paths, project.projectId, toSessionId) : null;
    const resolvedToRole = toRole ?? resolvedToSessionEntry?.role;
    if (!resolvedToRole) {
      throw new TaskActionError("unable to resolve discuss target role", "TASK_BINDING_MISMATCH", 409);
    }
    if (!isProjectRouteAllowed(project, fromAgent, resolvedToRole)) {
      throw new TaskActionError("discuss route denied", "TASK_ROUTE_DENIED");
    }
    const taskId = readString(actionInput.task_id) ?? readString(actionInput.taskId) ?? defaultTaskId;
    if (!taskId) {
      throw new TaskActionError("task_id is required for task discuss", "TASK_BINDING_REQUIRED", 400);
    }
    const resolvedToSession = await resolveTargetSession(dataRoot, project, paths, resolvedToRole, toSessionId);
    const content = readString(actionInput.content) ?? "";
    const routed = await routeProjectManagerMessage({
      dataRoot,
      project,
      paths,
      fromAgent,
      fromSessionId,
      messageType: actionType as "TASK_DISCUSS_REQUEST" | "TASK_DISCUSS_REPLY" | "TASK_DISCUSS_CLOSED",
      toRole: resolvedToRole,
      toSessionId: resolvedToSession,
      requestId,
      parentRequestId: readString(actionInput.parent_request_id),
      taskId,
      content,
      discuss: actionInput.discuss ?? null
    });
    return {
      success: true,
      requestId,
      actionType,
      taskId,
      messageId: routed.messageId
    };
  }
};

export const reportTaskActionHandler: TaskActionHandler = {
  actionTypes: ["TASK_REPORT"],
  async handle(context) {
    const { dataRoot, project, paths, actionInput, requestId, fromAgent, fromSessionId } = context;
    return runTaskActionWriteContext(dataRoot, { project, paths }, async () => {
      const report = normalizeTaskReport(project.projectId, fromSessionId, fromAgent, actionInput);
      const taskItems = await listTasks(paths, project.projectId);
      const byId = new Map(taskItems.map((task) => [task.taskId, task]));
      const predictedStateByTaskId = new Map(taskItems.map((task) => [task.taskId, task.state]));

      const acceptedResults: typeof report.results = [];
      const rejectedResults: TaskReportRejectedResult[] = [];
      for (const result of report.results) {
        const target = byId.get(result.taskId);
        if (!target) {
          rejectedResults.push({
            task_id: result.taskId,
            reason_code: "TASK_RESULT_INVALID_TARGET",
            reason: `task '${result.taskId}' not found`
          });
          continue;
        }

        const authorized = target.ownerRole === fromAgent || target.creatorRole === fromAgent;
        if (!authorized) {
          rejectedResults.push({
            task_id: result.taskId,
            reason_code: "TASK_RESULT_INVALID_TARGET",
            reason: `task '${result.taskId}' is neither owned nor created by ${fromAgent}`
          });
          continue;
        }

        const nextState = result.outcome;
        const currentState = predictedStateByTaskId.get(target.taskId) ?? target.state;
        const unresolvedDependencyTaskIds = resolveUnreadyDependencyTaskIds(target, byId, predictedStateByTaskId);
        if (requiresOrchestratorReadyDependencies(nextState) && unresolvedDependencyTaskIds.length > 0) {
          throw new TaskActionError(
            `task '${target.taskId}' cannot transition to '${nextState}' before dependencies are ready: ${unresolvedDependencyTaskIds.join(", ")}`,
            "TASK_DEPENDENCY_NOT_READY",
            409,
            {
              task_id: target.taskId,
              dependency_task_ids: unresolvedDependencyTaskIds,
              current_state: currentState,
              reported_target_state: nextState
            },
            buildDependencyNotReadyHint(target.taskId, unresolvedDependencyTaskIds)
          );
        }
        if (!isAllowedTaskReportTransition(currentState, nextState)) {
          rejectedResults.push({
            task_id: result.taskId,
            reason_code: "TASK_STATE_STALE",
            reason: `stale transition ${currentState} -> ${nextState}`,
            current_state: currentState,
            reported_target_state: nextState
          });
          continue;
        }

        acceptedResults.push(result);
        predictedStateByTaskId.set(target.taskId, nextState);
      }

      if (acceptedResults.length === 0) {
        const onlyStale =
          rejectedResults.length > 0 && rejectedResults.every((item) => item.reason_code === "TASK_STATE_STALE");
        throw new TaskActionError(
          onlyStale
            ? "TASK_REPORT transition is stale for all reported tasks"
            : "TASK_REPORT has no acceptable results",
          onlyStale ? "TASK_STATE_STALE" : "TASK_RESULT_INVALID_TARGET",
          409,
          {
            reportId: report.reportId,
            rejectedResults
          }
        );
      }

      const acceptedTaskIds = acceptedResults.map((item) => item.taskId);
      const acceptedReport = {
        ...report,
        results: acceptedResults
      };

      try {
        await validateAgentProgressFile(project, fromAgent, acceptedReport, {
          resultTaskIds: acceptedTaskIds
        });
      } catch (error) {
        if (error instanceof TaskProgressValidationError) {
          await appendEvent(paths, {
            projectId: project.projectId,
            eventType: "TASK_PROGRESS_VALIDATION_FAILED",
            source: "manager",
            sessionId: fromSessionId,
            payload: {
              requestId,
              fromAgent,
              reason: error.message,
              acceptedTaskIds
            }
          });
          throw new TaskActionError(error.message, "TASK_PROGRESS_REQUIRED");
        }
        throw error;
      }

      const update = await updateTaskboardFromTaskReport(paths, project.projectId, acceptedReport);
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "TASK_REPORT_APPLIED",
        source: "manager",
        sessionId: fromSessionId,
        taskId: report.parentTaskId ?? report.results[0]?.taskId,
        payload: {
          requestId,
          fromAgent,
          toRole: "manager",
          reportId: report.reportId,
          parentTaskId: report.parentTaskId ?? null,
          updatedTaskIds: update.updatedTaskIds,
          appliedTaskIds: acceptedTaskIds,
          rejectedResults,
          appliedCount: acceptedTaskIds.length,
          rejectedCount: rejectedResults.length
        }
      });
      await emitCreatorTerminalReportsIfReady(dataRoot, project, paths, requestId);
      return {
        success: true,
        requestId,
        actionType: "TASK_REPORT",
        taskId: report.parentTaskId ?? report.results[0]?.taskId,
        partialApplied: rejectedResults.length > 0,
        appliedTaskIds: acceptedTaskIds,
        rejectedResults
      };
    });
  }
};

export const defaultTaskActionHandlers: TaskActionHandler[] = [
  createTaskActionHandler,
  updateTaskActionHandler,
  assignTaskActionHandler,
  discussTaskActionHandler,
  reportTaskActionHandler
];
