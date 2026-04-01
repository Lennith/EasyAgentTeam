import type {
  WorkflowRunRecord,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeState,
  WorkflowTaskActionResult
} from "../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import { resolveWorkflowRunRoleScope } from "../workflow-role-scope-service.js";
import { collectWorkflowAncestorTaskIds, mergeWorkflowDependencies } from "./workflow-dispatch-policy.js";
import { convergeWorkflowRuntime } from "./runtime/workflow-runtime-kernel.js";
import { runOrchestratorTaskActionPipeline } from "./shared/index.js";
import type { WorkflowTaskActionPipelineState } from "./workflow-task-action-types.js";

export interface ApplyWorkflowTaskCreateActionInput {
  state: WorkflowTaskActionPipelineState;
  repositories: WorkflowRepositoryBundle;
  buildSnapshot(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): WorkflowRunRuntimeSnapshot;
  createRuntimeError(
    message: string,
    code: string,
    status?: number,
    hint?: string,
    details?: Record<string, unknown>
  ): Error;
}

export async function applyWorkflowTaskCreateAction(
  input: ApplyWorkflowTaskCreateActionInput
): Promise<Omit<WorkflowTaskActionResult, "requestId">> {
  return await runOrchestratorTaskActionPipeline(input.state, {
    parse: async (parsedState) => {
      const task = parsedState.input.task;
      if (!task) {
        throw input.createRuntimeError("task payload is required", "INVALID_TRANSITION", 400);
      }
      const taskId = task.taskId?.trim() ?? "";
      if (!taskId) {
        throw input.createRuntimeError("task.task_id is required", "INVALID_TRANSITION", 400);
      }
      const ownerRole = task.ownerRole?.trim() ?? "";
      const taskTitle = task.title?.trim() ?? "";
      if (!taskTitle || !ownerRole) {
        throw input.createRuntimeError("task.title and task.owner_role are required", "INVALID_TRANSITION", 400);
      }
      return {
        ...parsedState,
        task,
        taskId,
        ownerRole,
        taskTitle,
        parentTaskId: task.parentTaskId?.trim() || undefined,
        dependencies: (task.dependencies ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
        appliedTaskIds: [] as string[],
        rejectedResults: [] as WorkflowTaskActionResult["rejectedResults"]
      };
    },
    authorize: async (authorizedState) => {
      if (authorizedState.currentRun.tasks.some((item) => item.taskId === authorizedState.taskId)) {
        throw input.createRuntimeError(`task '${authorizedState.taskId}' already exists`, "INVALID_TRANSITION", 409);
      }
      const sessions = await input.repositories.sessions.listSessions(authorizedState.runId);
      const roleScope = resolveWorkflowRunRoleScope(authorizedState.currentRun, sessions);
      if (!roleScope.enabledAgentSet.has(authorizedState.ownerRole)) {
        throw input.createRuntimeError(
          `owner_role '${authorizedState.ownerRole}' does not exist in current run roles`,
          "TASK_OWNER_ROLE_NOT_FOUND",
          409,
          "Call route_targets_get first, choose an allowed target role, and retry TASK_CREATE once.",
          {
            owner_role: authorizedState.ownerRole,
            available_roles: roleScope.enabledAgents
          }
        );
      }
      if (
        authorizedState.parentTaskId &&
        !authorizedState.currentRun.tasks.some((item) => item.taskId === authorizedState.parentTaskId)
      ) {
        throw input.createRuntimeError(
          `parent task '${authorizedState.parentTaskId}' not found`,
          "TASK_NOT_FOUND",
          404
        );
      }
      const parentDependencies = authorizedState.parentTaskId
        ? (authorizedState.currentRun.tasks.find((item) => item.taskId === authorizedState.parentTaskId)
            ?.dependencies ?? [])
        : [];
      const dependencies = mergeWorkflowDependencies(parentDependencies, authorizedState.dependencies);
      for (const dep of dependencies) {
        if (!authorizedState.currentRun.tasks.some((item) => item.taskId === dep)) {
          throw input.createRuntimeError(`dependency task '${dep}' not found`, "TASK_NOT_FOUND", 404);
        }
      }
      return {
        ...authorizedState,
        dependencies
      };
    },
    checkDependencyGate: async (gatedState) => {
      const ancestorTaskIds = collectWorkflowAncestorTaskIds(
        gatedState.currentRun.tasks,
        gatedState.taskId,
        gatedState.parentTaskId
      );
      const ancestorTaskIdSet = new Set(ancestorTaskIds);
      const forbiddenDependencyIds = gatedState.dependencies.filter((dependencyId) =>
        ancestorTaskIdSet.has(dependencyId)
      );
      if (forbiddenDependencyIds.length > 0) {
        throw input.createRuntimeError(
          `dependencies cannot include parent/ancestor tasks: ${forbiddenDependencyIds.join(", ")}`,
          "TASK_DEPENDENCY_ANCESTOR_FORBIDDEN",
          409,
          undefined,
          {
            task_id: gatedState.taskId,
            parent_task_id: gatedState.parentTaskId ?? null,
            ancestor_task_ids: ancestorTaskIds,
            forbidden_dependency_ids: forbiddenDependencyIds
          }
        );
      }
      return gatedState;
    },
    apply: async (appliedState) => {
      const nextTasks: WorkflowRunRecord["tasks"] = [
        ...appliedState.currentRun.tasks,
        {
          taskId: appliedState.taskId,
          title: appliedState.taskTitle,
          resolvedTitle: appliedState.taskTitle,
          ownerRole: appliedState.ownerRole,
          parentTaskId: appliedState.parentTaskId,
          dependencies: appliedState.dependencies,
          acceptance: (appliedState.task.acceptance ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
          artifacts: (appliedState.task.artifacts ?? []).map((item) => item.trim()).filter((item) => item.length > 0),
          creatorRole: appliedState.input.fromAgent?.trim() || undefined,
          creatorSessionId: appliedState.input.fromSessionId?.trim() || undefined
        }
      ];
      appliedState.appliedTaskIds.push(appliedState.taskId);
      return {
        ...appliedState,
        nextTasks
      };
    },
    convergeRuntime: async (convergedState) => {
      const runWithNewTasks: WorkflowRunRecord = { ...convergedState.currentRun, tasks: convergedState.nextTasks };
      const nextRuntime = convergeWorkflowRuntime(runWithNewTasks, convergedState.currentRuntime).runtime;
      await input.repositories.workflowRuns.writeRuntime(convergedState.runId, nextRuntime);
      const updated = await input.repositories.workflowRuns.patchRun(convergedState.runId, {
        runtime: nextRuntime,
        tasks: convergedState.nextTasks
      });
      return {
        ...convergedState,
        nextRuntime,
        updated
      };
    },
    emit: async (emittedState) => ({
      success: true,
      actionType: emittedState.actionType,
      createdTaskId: emittedState.taskId,
      partialApplied: false,
      appliedTaskIds: emittedState.appliedTaskIds,
      rejectedResults: emittedState.rejectedResults,
      snapshot: input.buildSnapshot(emittedState.updated, emittedState.nextRuntime)
    })
  });
}
