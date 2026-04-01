import type { ProjectPaths, ProjectRecord, TaskActionResult, TaskRecord } from "../../domain/models.js";
import type { ProjectRepositoryBundle } from "../../data/repository/project-repository-bundle.js";
import { routeProjectTaskAssignmentMessage } from "../orchestrator/project-message-routing-service.js";
import {
  buildTaskAssignmentMessageForTask,
  mergeDependencies,
  readString,
  readStringList,
  resolveTargetSession
} from "./shared.js";
import { TaskActionError } from "./types.js";

interface TaskAssignmentMutationInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  repositories: ProjectRepositoryBundle;
  fromAgent: string;
  fromSessionId: string;
  requestId: string;
  task: TaskRecord;
  eventType: "TASK_CREATED" | "TASK_ASSIGN_UPDATED";
  actionType: "TASK_CREATE" | "TASK_ASSIGN";
}

interface ResolveTaskAssignmentOwnerInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  repositories: ProjectRepositoryBundle;
  fromAgent: string;
  ownerRole: string | null | undefined;
  toSessionId?: string;
  missingMessage: string;
}

interface TaskAssignmentSharedInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  repositories: ProjectRepositoryBundle;
  actionInput: Record<string, unknown>;
  requestId: string;
  fromAgent: string;
  fromSessionId: string;
}

export interface ApplyTaskCreateActionInput extends TaskAssignmentSharedInput {
  toRole?: string;
  toSessionId?: string;
}

export interface ApplyTaskAssignActionInput extends TaskAssignmentSharedInput {
  toRole?: string;
  toSessionId?: string;
  defaultTaskId?: string;
}

async function routeTaskAssignmentIfNeeded(input: {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  fromAgent: string;
  fromSessionId: string;
  requestId: string;
  task: TaskRecord;
}): Promise<void> {
  const { task } = input;
  if (!task.ownerSession || task.taskKind === "PROJECT_ROOT" || task.taskKind === "USER_ROOT") {
    return;
  }
  const taskMessage = buildTaskAssignmentMessageForTask(input.project, task);
  await routeProjectTaskAssignmentMessage({
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    fromAgent: input.fromAgent,
    fromSessionId: input.fromSessionId,
    requestId: input.requestId,
    taskId: task.taskId,
    toRole: task.ownerRole,
    toSessionId: task.ownerSession,
    message: taskMessage
  });
}

async function resolveTaskAssignmentOwner(input: ResolveTaskAssignmentOwnerInput): Promise<{
  ownerRole: string;
  ownerSession: string;
}> {
  const ownerRole = input.ownerRole?.trim();
  if (!ownerRole) {
    throw new TaskActionError(input.missingMessage, "TASK_BINDING_REQUIRED", 400);
  }
  if (!input.repositories.projectRuntime.isTaskAssignRouteAllowed(input.project, input.fromAgent, ownerRole)) {
    throw new TaskActionError("task assign route denied", "TASK_ROUTE_DENIED");
  }
  const ownerSession = await resolveTargetSession(
    input.dataRoot,
    input.project,
    input.paths,
    ownerRole,
    input.toSessionId
  );
  return {
    ownerRole,
    ownerSession
  };
}

async function finalizeTaskAssignmentMutation(
  input: TaskAssignmentMutationInput
): Promise<Pick<TaskActionResult, "success" | "requestId" | "actionType" | "taskId">> {
  await input.repositories.taskboard.recomputeRunnableStates(input.paths, input.project.projectId);
  await input.repositories.events.appendEvent(input.paths, {
    projectId: input.project.projectId,
    eventType: input.eventType,
    source: "manager",
    sessionId: input.fromSessionId,
    taskId: input.task.taskId,
    payload: {
      requestId: input.requestId,
      ownerRole: input.task.ownerRole,
      ownerSession: input.task.ownerSession ?? null
    }
  });
  await routeTaskAssignmentIfNeeded({
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    fromAgent: input.fromAgent,
    fromSessionId: input.fromSessionId,
    requestId: input.requestId,
    task: input.task
  });
  return {
    success: true,
    requestId: input.requestId,
    actionType: input.actionType,
    taskId: input.task.taskId
  };
}

export async function applyTaskCreateAction(input: ApplyTaskCreateActionInput): Promise<TaskActionResult> {
  const taskId = readString(input.actionInput.task_id) ?? readString(input.actionInput.taskId);
  const title = readString(input.actionInput.title);
  const ownerRole = readString(input.actionInput.owner_role) ?? readString(input.actionInput.ownerRole) ?? input.toRole;
  const parentTaskId = readString(input.actionInput.parent_task_id) ?? readString(input.actionInput.parentTaskId);
  const taskKind = (readString(input.actionInput.task_kind) ?? readString(input.actionInput.taskKind)) as
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
  const assignmentOwner = await resolveTaskAssignmentOwner({
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    repositories: input.repositories,
    fromAgent: input.fromAgent,
    ownerRole,
    toSessionId: input.toSessionId,
    missingMessage: "TASK_CREATE requires owner_role"
  });
  const explicitDependencies = readStringList(input.actionInput.dependencies);
  const parentTask = parentTaskId
    ? await input.repositories.taskboard.getTask(input.paths, input.project.projectId, parentTaskId).catch(() => null)
    : null;
  const inheritedDependencies = parentTask?.dependencies ?? [];
  const effectiveDependencies = mergeDependencies(inheritedDependencies, explicitDependencies);
  const created = await input.repositories.taskboard.createTask(input.paths, input.project.projectId, {
    taskId,
    taskKind: taskKind as any,
    parentTaskId,
    rootTaskId: readString(input.actionInput.root_task_id) ?? readString(input.actionInput.rootTaskId),
    title,
    creatorRole: input.fromAgent,
    creatorSessionId: input.fromSessionId,
    ownerRole: assignmentOwner.ownerRole,
    ownerSession: assignmentOwner.ownerSession,
    priority: Number(input.actionInput.priority ?? 0),
    dependencies: effectiveDependencies,
    writeSet: readStringList(input.actionInput.write_set ?? input.actionInput.writeSet),
    acceptance: readStringList(input.actionInput.acceptance),
    artifacts: readStringList(input.actionInput.artifacts),
    state: "PLANNED"
  });
  return await finalizeTaskAssignmentMutation({
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    repositories: input.repositories,
    fromAgent: input.fromAgent,
    fromSessionId: input.fromSessionId,
    requestId: input.requestId,
    task: created,
    eventType: "TASK_CREATED",
    actionType: "TASK_CREATE"
  });
}

export async function applyTaskAssignAction(input: ApplyTaskAssignActionInput): Promise<TaskActionResult> {
  const taskId = readString(input.actionInput.task_id) ?? readString(input.actionInput.taskId) ?? input.defaultTaskId;
  if (!taskId) {
    throw new TaskActionError("TASK_ASSIGN requires task_id and owner_role", "TASK_BINDING_REQUIRED", 400);
  }
  const assignmentOwner = await resolveTaskAssignmentOwner({
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    repositories: input.repositories,
    fromAgent: input.fromAgent,
    ownerRole: readString(input.actionInput.owner_role) ?? readString(input.actionInput.ownerRole) ?? input.toRole,
    toSessionId: input.toSessionId,
    missingMessage: "TASK_ASSIGN requires task_id and owner_role"
  });
  const dependenciesProvided = Object.prototype.hasOwnProperty.call(input.actionInput, "dependencies");
  const patched = await input.repositories.taskboard.patchTask(input.paths, input.project.projectId, taskId, {
    ownerRole: assignmentOwner.ownerRole,
    ownerSession: assignmentOwner.ownerSession,
    dependencies: dependenciesProvided ? readStringList(input.actionInput.dependencies) : undefined,
    priority: Number(input.actionInput.priority ?? Number.NaN),
    state: "PLANNED"
  });
  return await finalizeTaskAssignmentMutation({
    dataRoot: input.dataRoot,
    project: input.project,
    paths: input.paths,
    repositories: input.repositories,
    fromAgent: input.fromAgent,
    fromSessionId: input.fromSessionId,
    requestId: input.requestId,
    task: patched.task,
    eventType: "TASK_ASSIGN_UPDATED",
    actionType: "TASK_ASSIGN"
  });
}
