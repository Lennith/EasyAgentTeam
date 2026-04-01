import type { ProjectPaths, ProjectRecord, TaskActionResult } from "../../domain/models.js";
import type { ProjectRepositoryBundle } from "../../data/repository/project-repository-bundle.js";
import { routeProjectManagerMessage } from "../orchestrator/project-message-routing-service.js";
import { readString, resolveTargetSession } from "./shared.js";
import { TaskActionError } from "./types.js";

export interface ApplyTaskDiscussActionInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  repositories: ProjectRepositoryBundle;
  actionType: "TASK_DISCUSS_REQUEST" | "TASK_DISCUSS_REPLY" | "TASK_DISCUSS_CLOSED";
  actionInput: Record<string, unknown>;
  requestId: string;
  fromAgent: string;
  fromSessionId: string;
  toRole?: string;
  toSessionId?: string;
  defaultTaskId?: string;
}

export async function applyTaskDiscussAction(input: ApplyTaskDiscussActionInput): Promise<TaskActionResult> {
  if (!input.toRole && !input.toSessionId) {
    throw new TaskActionError("task discuss target is required", "TASK_BINDING_REQUIRED", 400);
  }
  const resolvedToSessionEntry = input.toSessionId
    ? await input.repositories.sessions.getSession(input.paths, input.project.projectId, input.toSessionId)
    : null;
  const resolvedToRole = input.toRole ?? resolvedToSessionEntry?.role;
  if (!resolvedToRole) {
    throw new TaskActionError("unable to resolve discuss target role", "TASK_BINDING_MISMATCH", 409);
  }
  if (!input.repositories.projectRuntime.isProjectRouteAllowed(input.project, input.fromAgent, resolvedToRole)) {
    throw new TaskActionError("discuss route denied", "TASK_ROUTE_DENIED");
  }
  const taskId = readString(input.actionInput.task_id) ?? readString(input.actionInput.taskId) ?? input.defaultTaskId;
  if (!taskId) {
    throw new TaskActionError("task_id is required for task discuss", "TASK_BINDING_REQUIRED", 400);
  }
  const resolvedToSession = await resolveTargetSession(
    input.dataRoot,
    input.project,
    input.paths,
    resolvedToRole,
    input.toSessionId
  );
  const content = readString(input.actionInput.content) ?? "";
  const routed = await routeProjectManagerMessage({
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    fromAgent: input.fromAgent,
    fromSessionId: input.fromSessionId,
    messageType: input.actionType,
    toRole: resolvedToRole,
    toSessionId: resolvedToSession,
    requestId: input.requestId,
    parentRequestId: readString(input.actionInput.parent_request_id),
    taskId,
    content,
    discuss: input.actionInput.discuss ?? null
  });
  return {
    success: true,
    requestId: input.requestId,
    actionType: input.actionType,
    taskId,
    messageId: routed.messageId
  };
}
