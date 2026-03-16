import { randomUUID } from "node:crypto";
import type {
  ProjectPaths,
  ProjectRecord,
  TaskActionResult,
  TaskRecord,
  TaskReport,
  TaskState,
  ManagerToAgentMessage
} from "../domain/models.js";
import { appendEvent } from "../data/event-store.js";
import { isProjectRouteAllowed, isTaskAssignRouteAllowed, setRoleSessionMapping } from "../data/project-store.js";
import { addSession, getSession } from "../data/session-store.js";
import {
  createTask,
  getTask,
  listTasks,
  patchTask,
  recomputeRunnableStates,
  TaskboardStoreError,
  type TaskPatchInput,
  updateTaskboardFromTaskReport
} from "../data/taskboard-store.js";
import {
  isReservedTargetSessionId,
  validateExplicitTargetSession,
  validateRoleSessionMapWrite
} from "./routing-guard-service.js";
import { deliverManagerMessage } from "./manager-routing-service.js";
import { emitMessageRouted, emitUserMessageReceived } from "./manager-routing-event-emitter-service.js";
import { validateAgentProgressFile, TaskProgressValidationError } from "./task-progress-validation-service.js";
import { emitCreatorTerminalReportsIfReady } from "./task-creator-terminal-report-service.js";
import { resolveActiveSessionForRole } from "./session-lifecycle-authority.js";

type TaskReportOutcome = TaskReport["results"][number]["outcome"];

export class TaskActionError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "TASK_ACTION_INVALID"
      | "TASK_BINDING_REQUIRED"
      | "TASK_BINDING_MISMATCH"
      | "TASK_ROUTE_DENIED"
      | "TASK_DEPENDENCY_CYCLE"
      | "TASK_DEPENDENCY_CROSS_ROOT"
      | "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN"
      | "TASK_NOT_RUNNABLE"
      | "TASK_RESULT_INVALID_TARGET"
      | "TASK_PROGRESS_REQUIRED"
      | "TASK_STATE_STALE"
      | "TASK_DEPENDENCY_NOT_READY"
      | "TASK_REPORT_NO_STATE_CHANGE"
      | "TASK_NOT_FOUND",
    status?: number,
    public readonly details?: Record<string, unknown>,
    public readonly hint?: string
  ) {
    super(message);
    if (status !== undefined) {
      this.status = status;
    } else {
      this.status = getDefaultStatusForCode(code);
    }
  }
  public readonly status: number;
}

function getDefaultStatusForCode(code: TaskActionError["code"]): number {
  switch (code) {
    case "TASK_ACTION_INVALID":
    case "TASK_BINDING_REQUIRED":
    case "TASK_PROGRESS_REQUIRED":
      return 400;
    case "TASK_RESULT_INVALID_TARGET":
    case "TASK_ROUTE_DENIED":
      return 403;
    case "TASK_NOT_FOUND":
      return 404;
    case "TASK_REPORT_NO_STATE_CHANGE":
    case "TASK_STATE_STALE":
    case "TASK_DEPENDENCY_NOT_READY":
    case "TASK_BINDING_MISMATCH":
    case "TASK_DEPENDENCY_CYCLE":
    case "TASK_DEPENDENCY_CROSS_ROOT":
    case "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN":
    case "TASK_NOT_RUNNABLE":
    default:
      return 409;
  }
}

interface TaskReportRejectedResult {
  task_id: string;
  reason_code: "TASK_RESULT_INVALID_TARGET" | "TASK_STATE_STALE";
  reason: string;
  current_state?: TaskState;
  reported_target_state?: TaskState;
}

function buildTaskAssignmentMessageForTask(
  project: ProjectRecord,
  task: {
    taskId: string;
    taskKind?: string;
    parentTaskId: string;
    rootTaskId?: string;
    title: string;
    state?: string;
    ownerRole: string;
    ownerSession?: string;
    priority?: number;
    writeSet?: string[];
    dependencies?: string[];
    acceptance?: string[];
    artifacts?: string[];
    lastSummary?: string;
  }
): ManagerToAgentMessage {
  const requestId = randomUUID();
  return {
    envelope: {
      message_id: randomUUID(),
      project_id: project.projectId,
      timestamp: new Date().toISOString(),
      sender: {
        type: "system",
        role: "manager",
        session_id: "manager-system"
      },
      via: { type: "manager" },
      intent: "TASK_ASSIGNMENT",
      priority: "normal",
      correlation: {
        request_id: requestId,
        task_id: task.taskId
      },
      accountability: {
        owner_role: task.ownerRole,
        report_to: { role: "manager", session_id: "manager-system" },
        expect: "TASK_REPORT"
      },
      dispatch_policy: "fixed_session"
    },
    body: {
      messageType: "TASK_ASSIGNMENT",
      mode: "CHAT",
      taskId: task.taskId,
      title: task.title,
      summary: task.lastSummary ?? "",
      task: {
        task_id: task.taskId,
        task_kind: task.taskKind,
        parent_task_id: task.parentTaskId,
        root_task_id: task.rootTaskId,
        state: task.state,
        owner_role: task.ownerRole,
        owner_session: task.ownerSession ?? null,
        priority: task.priority ?? 0,
        write_set: task.writeSet ?? [],
        dependencies: task.dependencies ?? [],
        acceptance: task.acceptance ?? [],
        artifacts: task.artifacts ?? []
      }
    }
  };
}

function buildTaskActionRejectedHint(code: TaskActionError["code"]): string | null {
  switch (code) {
    case "TASK_PROGRESS_REQUIRED":
      return "Update Agents/<agent>/progress.md with concrete progress and include every reported task_id, then resend once.";
    case "TASK_RESULT_INVALID_TARGET":
      return "Report only tasks owned by your role or created by your role.";
    case "TASK_BINDING_REQUIRED":
      return "Fill required binding fields (task_id, owner_role, parent_task_id, or discuss target).";
    case "TASK_BINDING_MISMATCH":
      return "Check target role/session mapping and retry with valid target binding.";
    case "TASK_ROUTE_DENIED":
      return "Choose an allowed route target or request route-table update.";
    case "TASK_ACTION_INVALID":
      return "Fix payload schema for the chosen action_type. For TASK_REPORT, send results[] with outcome in IN_PROGRESS|BLOCKED_DEP|DONE|CANCELED.";
    case "TASK_REPORT_NO_STATE_CHANGE":
      return "Do not resend identical report. Add new progress/results that change task state, then send once.";
    case "TASK_STATE_STALE":
      return "Task state is already newer than this report transition. Keep same-state report or continue with downstream tasks.";
    case "TASK_DEPENDENCY_NOT_READY":
      return "Wait for dependency tasks to reach DONE/CANCELED before reporting IN_PROGRESS/DONE for this task.";
    case "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN":
      return "Dependencies cannot include parent or ancestor task ids. Keep dependency edges only between sibling/peer tasks.";
    default:
      return null;
  }
}

function mapTaskboardStoreError(error: TaskboardStoreError): TaskActionError | null {
  if (error.code === "TASK_DEPENDENCY_CYCLE") {
    return new TaskActionError(error.message, "TASK_DEPENDENCY_CYCLE", 409, error.details);
  }
  if (error.code === "TASK_DEPENDENCY_CROSS_ROOT") {
    return new TaskActionError(error.message, "TASK_DEPENDENCY_CROSS_ROOT", 409, error.details);
  }
  if (error.code === "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN") {
    return new TaskActionError(error.message, "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN", 409, error.details);
  }
  if (error.code === "TASK_NOT_FOUND") {
    return new TaskActionError(error.message, "TASK_NOT_FOUND", 404, error.details);
  }
  return null;
}

function isAllowedTaskReportTransition(current: TaskState, target: TaskState): boolean {
  if (current === "DONE" || current === "CANCELED") {
    return target === current;
  }
  return true;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
}

function mergeDependencies(parentDependencies: string[], explicitDependencies: string[]): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const dep of [...parentDependencies, ...explicitDependencies]) {
    const normalized = dep.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }
  return merged;
}

function resolveUnreadyDependencyTaskIds(
  task: TaskRecord,
  byId: Map<string, TaskRecord>,
  stateByTaskId?: Map<string, TaskState>
): string[] {
  const unresolved: string[] = [];
  for (const depId of task.dependencies ?? []) {
    const depState = stateByTaskId?.get(depId) ?? byId.get(depId)?.state;
    if (depState !== "DONE" && depState !== "CANCELED") {
      unresolved.push(depId);
    }
  }
  return unresolved;
}

function buildDependencyNotReadyHint(taskId: string, dependencyTaskIds: string[]): string {
  const deps = dependencyTaskIds.join(", ");
  return (
    `Task '${taskId}' cannot be progressed yet. Wait for dependencies [${deps}] to reach DONE/CANCELED. ` +
    "If you already produced conflicting completion content, retract or downgrade it to draft and retry after dependencies are complete."
  );
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function buildTaskActionAuditPayload(
  actionType: string,
  requestId: string,
  fromAgent: string,
  toRole: string | undefined,
  toSessionId: string | undefined,
  actionInput: Record<string, unknown>
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    requestId,
    actionType,
    fromAgent,
    toRole: toRole ?? null,
    toSessionId: toSessionId ?? null
  };

  if (actionType === "TASK_CREATE") {
    return {
      ...base,
      task_id: readString(actionInput.task_id) ?? readString(actionInput.taskId) ?? null,
      task_kind: readString(actionInput.task_kind) ?? readString(actionInput.taskKind) ?? "EXECUTION",
      parent_task_id: readString(actionInput.parent_task_id) ?? readString(actionInput.parentTaskId) ?? null,
      root_task_id: readString(actionInput.root_task_id) ?? readString(actionInput.rootTaskId) ?? null,
      title: readString(actionInput.title) ?? null,
      owner_role: readString(actionInput.owner_role) ?? readString(actionInput.ownerRole) ?? null,
      owner_session: readString(actionInput.owner_session) ?? readString(actionInput.ownerSession) ?? null,
      priority: readNumber(actionInput.priority) ?? 0,
      dependencies: readStringList(actionInput.dependencies),
      write_set: readStringList(actionInput.write_set ?? actionInput.writeSet),
      acceptance: readStringList(actionInput.acceptance),
      artifacts: readStringList(actionInput.artifacts),
      content: readString(actionInput.content) ?? null
    };
  }

  if (actionType === "TASK_ASSIGN") {
    const dependenciesProvided = Object.prototype.hasOwnProperty.call(actionInput, "dependencies");
    return {
      ...base,
      task_id: readString(actionInput.task_id) ?? readString(actionInput.taskId) ?? null,
      owner_role: readString(actionInput.owner_role) ?? readString(actionInput.ownerRole) ?? null,
      owner_session: readString(actionInput.owner_session) ?? readString(actionInput.ownerSession) ?? null,
      priority: readNumber(actionInput.priority) ?? null,
      dependencies_provided: dependenciesProvided,
      dependencies: dependenciesProvided ? readStringList(actionInput.dependencies) : null,
      write_set: readStringList(actionInput.write_set ?? actionInput.writeSet),
      acceptance: readStringList(actionInput.acceptance),
      artifacts: readStringList(actionInput.artifacts),
      content: readString(actionInput.content) ?? null
    };
  }

  if (actionType === "TASK_REPORT") {
    const rawResults = Array.isArray(actionInput.results) ? actionInput.results : [];
    const resultTaskIds = rawResults
      .filter((row) => row && typeof row === "object")
      .map((row) => {
        const obj = row as Record<string, unknown>;
        return readString(obj.task_id) ?? readString(obj.taskId) ?? "";
      })
      .filter((item) => item.length > 0);
    return {
      ...base,
      task_id: readString(actionInput.task_id) ?? readString(actionInput.taskId) ?? null,
      parent_task_id: readString(actionInput.parent_task_id) ?? readString(actionInput.parentTaskId) ?? null,
      summary: readString(actionInput.summary) ?? null,
      report_mode: readString(actionInput.report_mode ?? actionInput.reportMode) ?? null,
      report_content: readString(actionInput.report_content ?? actionInput.reportContent) ?? null,
      report_file: readString(actionInput.report_file ?? actionInput.reportFile) ?? null,
      results_count: rawResults.length,
      result_task_ids: resultTaskIds
    };
  }

  if (actionType.startsWith("TASK_DISCUSS")) {
    return {
      ...base,
      task_id: readString(actionInput.task_id) ?? readString(actionInput.taskId) ?? null,
      parent_request_id: readString(actionInput.parent_request_id) ?? readString(actionInput.parentRequestId) ?? null,
      content: readString(actionInput.content) ?? null,
      discuss: actionInput.discuss ?? null
    };
  }

  return base;
}

async function resolveTargetSession(
  dataRoot: string,
  project: ProjectRecord,
  paths: ProjectPaths,
  toRole: string,
  explicitToSessionId?: string
): Promise<string> {
  const configuredProviderId = project.agentModelConfigs?.[toRole]?.provider_id;
  if (
    configuredProviderId &&
    configuredProviderId !== "codex" &&
    configuredProviderId !== "trae" &&
    configuredProviderId !== "minimax"
  ) {
    throw new TaskActionError(
      `SESSION_PROVIDER_NOT_SUPPORTED: role '${toRole}' is configured with unsupported provider '${configuredProviderId}'`,
      "TASK_BINDING_MISMATCH",
      409
    );
  }

  if (explicitToSessionId) {
    const validation = await validateExplicitTargetSession(paths, project.projectId, explicitToSessionId, toRole);
    if (!validation.ok) {
      throw new TaskActionError(validation.error.message, "TASK_BINDING_MISMATCH", 409, {
        validation: validation.error
      });
    }
    return validation.sessionId;
  }

  const latest = await resolveActiveSessionForRole({
    dataRoot,
    project,
    paths,
    role: toRole,
    reason: "task_action_resolve_target"
  });
  if (latest) {
    return latest.sessionId;
  }

  const safeRole = toRole.replace(/[^a-zA-Z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  const sessionId = `session-${safeRole || "agent"}-${randomUUID().slice(0, 12)}`;
  if (isReservedTargetSessionId(sessionId)) {
    throw new TaskActionError("resolved target session is reserved", "TASK_BINDING_MISMATCH");
  }
  const toRoleProviderId = project.agentModelConfigs?.[toRole]?.provider_id ?? "minimax";
  await addSession(paths, project.projectId, {
    sessionId,
    role: toRole,
    status: "idle",
    providerSessionId: undefined,
    provider: toRoleProviderId
  });
  const mappingError = validateRoleSessionMapWrite(toRole, sessionId);
  if (!mappingError) {
    await setRoleSessionMapping(dataRoot, project.projectId, toRole, sessionId);
  }
  return sessionId;
}

function normalizeTaskReport(
  projectId: string,
  fromSessionId: string,
  fromAgent: string,
  payload: Record<string, unknown>
): TaskReport {
  const reportId = readString(payload.report_id) ?? readString(payload.reportId) ?? randomUUID();
  if (
    Object.prototype.hasOwnProperty.call(payload, "report_mode") ||
    Object.prototype.hasOwnProperty.call(payload, "reportMode")
  ) {
    throw new TaskActionError(
      "TASK_REPORT report_mode is retired. Use results[] with outcome in IN_PROGRESS|BLOCKED_DEP|DONE|CANCELED.",
      "TASK_ACTION_INVALID",
      400
    );
  }
  const summary = readString(payload.summary) ?? "";
  const parentTaskId = readString(payload.parent_task_id) ?? readString(payload.parentTaskId);
  const resultsRaw = Array.isArray(payload.results) ? payload.results : [];
  if (resultsRaw.length === 0) {
    throw new TaskActionError(
      "TASK_REPORT requires results[] with outcome in IN_PROGRESS|BLOCKED_DEP|DONE|CANCELED",
      "TASK_ACTION_INVALID",
      400
    );
  }
  const results = resultsRaw
    .filter((row) => row && typeof row === "object")
    .map((row) => {
      const obj = row as Record<string, unknown>;
      const taskId = readString(obj.task_id) ?? readString(obj.taskId);
      const outcomeRaw = readString(obj.outcome)?.toUpperCase();
      if (!taskId || !outcomeRaw) {
        throw new TaskActionError("TASK_REPORT result requires task_id and outcome", "TASK_ACTION_INVALID", 400);
      }
      if (["PARTIAL", "BLOCKED", "FAILED"].includes(outcomeRaw)) {
        throw new TaskActionError(
          `retired outcome '${outcomeRaw}'. Use IN_PROGRESS|BLOCKED_DEP|DONE|CANCELED.`,
          "TASK_ACTION_INVALID",
          400
        );
      }
      if (!["IN_PROGRESS", "BLOCKED_DEP", "DONE", "CANCELED"].includes(outcomeRaw)) {
        throw new TaskActionError(
          `unsupported outcome: ${outcomeRaw}. Use IN_PROGRESS|BLOCKED_DEP|DONE|CANCELED.`,
          "TASK_ACTION_INVALID",
          400
        );
      }
      return {
        taskId,
        outcome: outcomeRaw as TaskReportOutcome,
        summary: readString(obj.summary),
        artifacts: readStringList(obj.artifacts),
        blockers: readStringList(obj.blockers)
      };
    });

  return {
    schemaVersion: "1.0",
    reportId,
    projectId,
    sessionId: fromSessionId,
    agentId: fromAgent,
    parentTaskId,
    summary,
    createdAt: new Date().toISOString(),
    results,
    correlation: {
      request_id: readString(payload.request_id) ?? randomUUID(),
      parent_request_id: readString(payload.parent_request_id),
      task_id: parentTaskId
    }
  };
}

export async function handleTaskAction(
  dataRoot: string,
  project: ProjectRecord,
  paths: ProjectPaths,
  body: Record<string, unknown>
): Promise<TaskActionResult> {
  const actionTypeRaw = readString(body.action_type) ?? readString(body.actionType);
  const requestId = readString(body.request_id) ?? readString(body.requestId) ?? randomUUID();
  const fromAgent = readString(body.from_agent) ?? readString(body.fromAgent) ?? "manager";
  const fromSessionToken = readString(body.from_session_id) ?? readString(body.fromSessionId) ?? "manager-system";
  const toRole = readString(body.to_role) ?? readString(body.toRole);
  const toSessionId = readString(body.to_session_id) ?? readString(body.toSessionId);
  const payload = (body.payload && typeof body.payload === "object" ? body.payload : {}) as Record<string, unknown>;
  const actionInput = { ...body, ...payload } as Record<string, unknown>;
  const reportRows = Array.isArray(actionInput.results) ? actionInput.results : [];
  const firstReportTaskId = reportRows
    .map((row) => {
      if (!row || typeof row !== "object") {
        return undefined;
      }
      const obj = row as Record<string, unknown>;
      return readString(obj.task_id) ?? readString(obj.taskId);
    })
    .find((item) => Boolean(item));
  const defaultTaskId =
    readString(actionInput.task_id) ??
    readString(actionInput.taskId) ??
    readString(actionInput.parent_task_id) ??
    readString(actionInput.parentTaskId) ??
    firstReportTaskId;
  const normalizedActionType = actionTypeRaw?.toUpperCase();
  const actionType =
    normalizedActionType &&
    [
      "TASK_CREATE",
      "TASK_UPDATE",
      "TASK_ASSIGN",
      "TASK_DISCUSS_REQUEST",
      "TASK_DISCUSS_REPLY",
      "TASK_DISCUSS_CLOSED",
      "TASK_REPORT"
    ].includes(normalizedActionType)
      ? (normalizedActionType as TaskActionResult["actionType"])
      : undefined;
  const normalizedToRole = toRole ?? (actionType === "TASK_REPORT" ? "manager" : undefined);
  const resolvedFromSession =
    fromSessionToken === "manager-system"
      ? null
      : await getSession(paths, project.projectId, fromSessionToken).catch(() => null);
  const fromSessionId = resolvedFromSession?.sessionId ?? fromSessionToken;

  const auditPayload = buildTaskActionAuditPayload(
    actionType ?? normalizedActionType ?? "UNKNOWN",
    requestId,
    fromAgent,
    normalizedToRole,
    toSessionId,
    actionInput
  );

  await appendEvent(paths, {
    projectId: project.projectId,
    eventType: "TASK_ACTION_RECEIVED",
    source: "manager",
    sessionId: fromSessionId,
    taskId: defaultTaskId,
    payload: auditPayload
  });

  try {
    if (!actionType) {
      throw new TaskActionError("action_type is invalid", "TASK_ACTION_INVALID", 400);
    }

    if (actionType === "TASK_CREATE") {
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
        await deliverManagerMessage({
          dataRoot,
          project,
          paths,
          message: taskMessage,
          targetRole: created.ownerRole,
          targetSessionId: created.ownerSession,
          updateRoleSessionMap: true
        });
      }
      return {
        success: true,
        requestId,
        actionType: "TASK_CREATE",
        taskId: created.taskId
      };
    }

    if (actionType === "TASK_UPDATE") {
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
    }

    if (actionType === "TASK_ASSIGN") {
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
        await deliverManagerMessage({
          dataRoot,
          project,
          paths,
          message: taskMessage,
          targetRole: patched.task.ownerRole,
          targetSessionId: patched.task.ownerSession,
          updateRoleSessionMap: true
        });
      }
      return {
        success: true,
        requestId,
        actionType: "TASK_ASSIGN",
        taskId: patched.task.taskId
      };
    }

    if (
      actionType === "TASK_DISCUSS_REQUEST" ||
      actionType === "TASK_DISCUSS_REPLY" ||
      actionType === "TASK_DISCUSS_CLOSED"
    ) {
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
      const messageId = randomUUID();
      const managerMessage = {
        envelope: {
          message_id: messageId,
          project_id: project.projectId,
          timestamp: new Date().toISOString(),
          sender: {
            type: fromAgent === "manager" ? ("system" as const) : ("agent" as const),
            role: fromAgent,
            session_id: fromSessionId
          },
          via: { type: "manager" as const },
          intent: "TASK_DISCUSS",
          priority: "normal" as const,
          correlation: {
            request_id: requestId,
            parent_request_id: readString(actionInput.parent_request_id),
            task_id: taskId
          },
          accountability: {
            owner_role: resolvedToRole,
            report_to: {
              role: fromAgent,
              session_id: fromSessionId
            },
            expect: actionType === "TASK_DISCUSS_REQUEST" ? ("DISCUSS_REPLY" as const) : ("TASK_REPORT" as const)
          },
          dispatch_policy: "fixed_session" as const
        },
        body: {
          content,
          mode: "CHAT",
          messageType: actionType,
          taskId,
          discuss: actionInput.discuss ?? null
        }
      };
      await deliverManagerMessage({
        dataRoot,
        project,
        paths,
        message: managerMessage,
        targetRole: resolvedToRole,
        targetSessionId: resolvedToSession,
        currentTaskId: taskId,
        updateRoleSessionMap: true
      });

      await emitUserMessageReceived(
        {
          projectId: project.projectId,
          paths,
          source: "manager",
          taskId
        },
        {
          requestId,
          content,
          fromAgent,
          toRole: resolvedToRole,
          mode: "CHAT",
          messageType: actionType,
          taskId,
          discuss: actionInput.discuss ?? null
        }
      );
      await emitMessageRouted(
        {
          projectId: project.projectId,
          paths,
          source: "manager",
          sessionId: resolvedToSession,
          taskId
        },
        {
          requestId,
          toRole: resolvedToRole,
          resolvedSessionId: resolvedToSession,
          messageId,
          mode: "CHAT",
          messageType: actionType,
          taskId,
          discuss: actionInput.discuss ?? null,
          content
        }
      );
      return {
        success: true,
        requestId,
        actionType: actionType as TaskActionResult["actionType"],
        taskId,
        messageId
      };
    }

    if (actionType === "TASK_REPORT") {
      const report = normalizeTaskReport(project.projectId, fromSessionId, fromAgent, actionInput);
      const taskItems = await listTasks(paths, project.projectId);
      const byId = new Map(taskItems.map((task) => [task.taskId, task]));
      const predictedStateByTaskId = new Map(taskItems.map((task) => [task.taskId, task.state]));

      const acceptedResults: TaskReport["results"] = [];
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
        const progressOutcome = nextState === "IN_PROGRESS" || nextState === "DONE";
        if (progressOutcome && unresolvedDependencyTaskIds.length > 0) {
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
      const acceptedReport: TaskReport = {
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
    }

    throw new TaskActionError("unsupported action", "TASK_ACTION_INVALID", 400);
  } catch (error) {
    let normalizedError: unknown = error;
    if (error instanceof TaskboardStoreError) {
      const mapped = mapTaskboardStoreError(error);
      if (mapped) {
        normalizedError = mapped;
      }
    }
    if (normalizedError instanceof TaskActionError) {
      const hint = normalizedError.hint ?? buildTaskActionRejectedHint(normalizedError.code);
      await appendEvent(paths, {
        projectId: project.projectId,
        eventType: "TASK_ACTION_REJECTED",
        source: "manager",
        sessionId: fromSessionId,
        taskId: defaultTaskId,
        payload: {
          requestId,
          actionType: actionType ?? normalizedActionType ?? "UNKNOWN",
          fromAgent,
          toRole: normalizedToRole ?? null,
          toSessionId: toSessionId ?? null,
          error_code: normalizedError.code,
          reason: normalizedError.message,
          hint,
          details: normalizedError.details ?? null
        }
      });
    }
    throw normalizedError;
  }
}
