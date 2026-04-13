import type { WorkflowTaskActionResult } from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { resolveWorkflowRunRoleScope } from "../../workflow-role-scope-service.js";
import { buildRouteTargetsGuidance, buildTaskExistsNextAction } from "../../teamtool-contract.js";
import { collectWorkflowAncestorTaskIds, mergeWorkflowDependencies } from "./workflow-dispatch-policy.js";
import type { WorkflowTaskActionPipelineState } from "./workflow-task-action-types.js";

export type WorkflowTaskCreateMutableState = WorkflowTaskActionPipelineState & {
  task: NonNullable<WorkflowTaskActionPipelineState["input"]["task"]>;
  taskId: string;
  ownerRole: string;
  taskTitle: string;
  parentTaskId?: string;
  dependencies: string[];
  appliedTaskIds: string[];
  rejectedResults: WorkflowTaskActionResult["rejectedResults"];
};

export interface WorkflowTaskCreateErrorFactory {
  (message: string, code: string, status?: number, nextAction?: string, details?: Record<string, unknown>): Error;
}

export async function parseWorkflowTaskCreateState(
  state: WorkflowTaskActionPipelineState,
  createRuntimeError: WorkflowTaskCreateErrorFactory
): Promise<WorkflowTaskCreateMutableState> {
  const task = state.input.task;
  if (!task) {
    throw createRuntimeError("task payload is required", "INVALID_TRANSITION", 400);
  }
  const taskId = task.taskId?.trim() ?? "";
  if (!taskId) {
    throw createRuntimeError("task.task_id is required", "INVALID_TRANSITION", 400);
  }
  const ownerRole = task.ownerRole?.trim() ?? "";
  const taskTitle = task.title?.trim() ?? "";
  if (!taskTitle || !ownerRole) {
    throw createRuntimeError("task.title and task.owner_role are required", "INVALID_TRANSITION", 400);
  }
  return {
    ...state,
    task,
    taskId,
    ownerRole,
    taskTitle,
    parentTaskId: task.parentTaskId?.trim() || undefined,
    dependencies: (task.dependencies ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
    appliedTaskIds: [],
    rejectedResults: []
  };
}

export async function authorizeWorkflowTaskCreateState<TState extends WorkflowTaskCreateMutableState>(
  state: TState,
  repositories: Pick<WorkflowRepositoryBundle, "sessions">,
  createRuntimeError: WorkflowTaskCreateErrorFactory
): Promise<TState> {
  if (state.currentRun.tasks.some((item) => item.taskId === state.taskId)) {
    throw createRuntimeError(`task '${state.taskId}' already exists`, "TASK_EXISTS", 409, buildTaskExistsNextAction(), {
      task_id: state.taskId,
      parent_task_id: state.parentTaskId ?? null,
      owner_role: state.ownerRole
    });
  }

  const sessions = await repositories.sessions.listSessions(state.runId);
  const roleScope = resolveWorkflowRunRoleScope(state.currentRun, sessions);
  if (!roleScope.enabledAgentSet.has(state.ownerRole)) {
    throw createRuntimeError(
      `owner_role '${state.ownerRole}' does not exist in current run roles`,
      "TASK_OWNER_ROLE_NOT_FOUND",
      409,
      buildRouteTargetsGuidance("choose an allowed target role, and retry TASK_CREATE once."),
      {
        owner_role: state.ownerRole,
        available_roles: roleScope.enabledAgents
      }
    );
  }

  if (state.parentTaskId && !state.currentRun.tasks.some((item) => item.taskId === state.parentTaskId)) {
    throw createRuntimeError(`parent task '${state.parentTaskId}' not found`, "TASK_NOT_FOUND", 404);
  }

  const parentDependencies = state.parentTaskId
    ? (state.currentRun.tasks.find((item) => item.taskId === state.parentTaskId)?.dependencies ?? [])
    : [];
  const dependencies = mergeWorkflowDependencies(parentDependencies, state.dependencies);
  for (const dependencyId of dependencies) {
    if (!state.currentRun.tasks.some((item) => item.taskId === dependencyId)) {
      throw createRuntimeError(`dependency task '${dependencyId}' not found`, "TASK_NOT_FOUND", 404);
    }
  }

  return {
    ...state,
    dependencies
  };
}

export async function checkWorkflowTaskCreateDependencyGate<TState extends WorkflowTaskCreateMutableState>(
  state: TState,
  createRuntimeError: WorkflowTaskCreateErrorFactory
): Promise<TState> {
  const ancestorTaskIds = collectWorkflowAncestorTaskIds(state.currentRun.tasks, state.taskId, state.parentTaskId);
  const ancestorTaskIdSet = new Set(ancestorTaskIds);
  const forbiddenDependencyIds = state.dependencies.filter((dependencyId) => ancestorTaskIdSet.has(dependencyId));
  if (forbiddenDependencyIds.length === 0) {
    return state;
  }

  throw createRuntimeError(
    `dependencies cannot include parent/ancestor tasks: ${forbiddenDependencyIds.join(", ")}`,
    "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN",
    409,
    undefined,
    {
      task_id: state.taskId,
      parent_task_id: state.parentTaskId ?? null,
      ancestor_task_ids: ancestorTaskIds,
      forbidden_dependency_ids: forbiddenDependencyIds
    }
  );
}
