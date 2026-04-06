import { randomUUID } from "node:crypto";
import type {
  ManagerToAgentMessage,
  ProjectPaths,
  ProjectRecord,
  TaskRecord,
  TaskReport,
  TaskState
} from "../../domain/models.js";
import { getProjectRepositoryBundle } from "../../data/repository/project/repository-bundle.js";
import { TaskboardStoreError } from "../../data/repository/project/taskboard-repository.js";
import {
  isReservedTargetSessionId,
  validateExplicitTargetSession,
  validateRoleSessionMapWrite
} from "../routing-guard-service.js";
import { resolveActiveSessionForRole } from "../session-lifecycle-authority.js";
import {
  buildOrchestratorDependencyNotReadyHint,
  collectOrchestratorUnreadyDependencyIds,
  buildOrchestratorTaskAssignmentMessage,
  buildRoleScopedSessionId,
  getOrchestratorTaskReportOutcomeLabel,
  isOrchestratorRetiredTaskReportOutcome,
  normalizeOrchestratorTaskReportOutcomeToken,
  parseOrchestratorTaskReportOutcome,
  requiresOrchestratorReadyDependencies
} from "../orchestrator/shared/index.js";
import { TaskActionError, type TaskReportRejectedResult } from "./types.js";

type TaskReportOutcome = TaskReport["results"][number]["outcome"];

export function buildTaskAssignmentMessageForTask(project: ProjectRecord, task: TaskRecord): ManagerToAgentMessage {
  const requestId = randomUUID();
  return buildOrchestratorTaskAssignmentMessage({
    scopeKind: "project",
    scopeId: project.projectId,
    messageId: randomUUID(),
    createdAt: new Date().toISOString(),
    senderType: "system",
    senderRole: "manager",
    senderSessionId: "manager-system",
    intent: "TASK_ASSIGNMENT",
    requestId,
    taskId: task.taskId,
    ownerRole: task.ownerRole,
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

export function buildTaskActionRejectedHint(code: TaskActionError["code"]): string | null {
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
      return `Fix payload schema for the chosen action_type. For TASK_REPORT, send results[] with outcome in ${getOrchestratorTaskReportOutcomeLabel()}.`;
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

export function mapTaskboardStoreError(error: TaskboardStoreError): TaskActionError | null {
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

export function isAllowedTaskReportTransition(current: TaskState, target: TaskState): boolean {
  if (current === "DONE" || current === "CANCELED") {
    return target === current;
  }
  return true;
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
}

export function mergeDependencies(parentDependencies: string[], explicitDependencies: string[]): string[] {
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

export function resolveUnreadyDependencyTaskIds(
  task: TaskRecord,
  byId: Map<string, TaskRecord>,
  stateByTaskId?: Map<string, TaskState>
): string[] {
  return collectOrchestratorUnreadyDependencyIds(task.dependencies ?? [], (dependencyId) => {
    return stateByTaskId?.get(dependencyId) ?? byId.get(dependencyId)?.state;
  });
}

export function buildDependencyNotReadyHint(taskId: string, dependencyTaskIds: string[]): string {
  return buildOrchestratorDependencyNotReadyHint(taskId, dependencyTaskIds);
}

export { requiresOrchestratorReadyDependencies };

export function readNumber(value: unknown): number | undefined {
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

export function buildTaskActionAuditPayload(
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

export async function resolveTargetSession(
  dataRoot: string,
  project: ProjectRecord,
  paths: ProjectPaths,
  toRole: string,
  explicitToSessionId?: string
): Promise<string> {
  const repositories = getProjectRepositoryBundle(dataRoot);
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

  const sessionId = buildRoleScopedSessionId(toRole);
  if (isReservedTargetSessionId(sessionId)) {
    throw new TaskActionError("resolved target session is reserved", "TASK_BINDING_MISMATCH");
  }
  const toRoleProviderId = project.agentModelConfigs?.[toRole]?.provider_id ?? "minimax";
  await repositories.sessions.addSession(paths, project.projectId, {
    sessionId,
    role: toRole,
    status: "idle",
    providerSessionId: undefined,
    provider: toRoleProviderId
  });
  const mappingError = validateRoleSessionMapWrite(toRole, sessionId);
  if (!mappingError) {
    await repositories.projectRuntime.setRoleSessionMapping(project.projectId, toRole, sessionId);
  }
  return sessionId;
}

export function normalizeTaskReport(
  projectId: string,
  fromSessionId: string,
  fromAgent: string,
  payload: Record<string, unknown>
): TaskReport {
  const reportId = readString(payload.report_id) ?? readString(payload.reportId) ?? randomUUID();
  const stableOutcomeLabel = getOrchestratorTaskReportOutcomeLabel();
  if (
    Object.prototype.hasOwnProperty.call(payload, "report_mode") ||
    Object.prototype.hasOwnProperty.call(payload, "reportMode")
  ) {
    throw new TaskActionError(
      `TASK_REPORT report_mode is retired. Use results[] with outcome in ${stableOutcomeLabel}.`,
      "TASK_ACTION_INVALID",
      400
    );
  }
  const summary = readString(payload.summary) ?? "";
  const parentTaskId = readString(payload.parent_task_id) ?? readString(payload.parentTaskId);
  const resultsRaw = Array.isArray(payload.results) ? payload.results : [];
  if (resultsRaw.length === 0) {
    throw new TaskActionError(
      `TASK_REPORT requires results[] with outcome in ${stableOutcomeLabel}`,
      "TASK_ACTION_INVALID",
      400
    );
  }
  const results = resultsRaw
    .filter((row) => row && typeof row === "object")
    .map((row) => {
      const obj = row as Record<string, unknown>;
      const taskId = readString(obj.task_id) ?? readString(obj.taskId);
      const outcomeInput = readString(obj.outcome);
      const outcomeRaw = outcomeInput ? normalizeOrchestratorTaskReportOutcomeToken(outcomeInput) : undefined;
      if (!taskId || !outcomeRaw) {
        throw new TaskActionError("TASK_REPORT result requires task_id and outcome", "TASK_ACTION_INVALID", 400);
      }
      if (isOrchestratorRetiredTaskReportOutcome(outcomeRaw)) {
        throw new TaskActionError(
          `retired outcome '${outcomeRaw}'. Use ${stableOutcomeLabel}.`,
          "TASK_ACTION_INVALID",
          400
        );
      }
      const parsedOutcome = parseOrchestratorTaskReportOutcome(outcomeRaw);
      if (!parsedOutcome) {
        throw new TaskActionError(
          `unsupported outcome: ${outcomeRaw}. Use ${stableOutcomeLabel}.`,
          "TASK_ACTION_INVALID",
          400
        );
      }
      return {
        taskId,
        outcome: parsedOutcome as TaskReportOutcome,
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

export function readDefaultTaskId(actionInput: Record<string, unknown>): string | undefined {
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
  return (
    readString(actionInput.task_id) ??
    readString(actionInput.taskId) ??
    readString(actionInput.parent_task_id) ??
    readString(actionInput.parentTaskId) ??
    firstReportTaskId
  );
}

export type { TaskReportRejectedResult };
