import type {
  WorkflowRunRecord,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeState,
  WorkflowTaskActionRequest,
  WorkflowTaskActionResult,
  WorkflowTaskState
} from "../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import { resolveWorkflowRunRoleScope } from "../workflow-role-scope-service.js";
import { collectWorkflowAncestorTaskIds, mergeWorkflowDependencies } from "./workflow-dispatch-policy.js";
import {
  addWorkflowTaskTransition,
  convergeWorkflowRuntime,
  resolveWorkflowUnreadyDependencyTaskIds
} from "./runtime/workflow-runtime-kernel.js";
import { requiresOrchestratorReadyDependencies, runOrchestratorTaskActionPipeline } from "./shared/index.js";
import type { WorkflowMessageRouteResult, WorkflowRouteMessageInput } from "./workflow-message-routing-service.js";

const REPORTABLE_STATES = new Set<WorkflowTaskState>([
  "PLANNED",
  "READY",
  "DISPATCHED",
  "IN_PROGRESS",
  "BLOCKED_DEP",
  "MAY_BE_DONE"
]);

function parseOutcome(outcome: string): WorkflowTaskState | null {
  if (outcome === "IN_PROGRESS") return "IN_PROGRESS";
  if (outcome === "BLOCKED_DEP") return "BLOCKED_DEP";
  if (outcome === "MAY_BE_DONE") return "MAY_BE_DONE";
  if (outcome === "DONE") return "DONE";
  if (outcome === "CANCELED") return "CANCELED";
  return null;
}

interface WorkflowTaskActionServiceContext {
  repositories: WorkflowRepositoryBundle;
  loadRunOrThrow(runId: string): Promise<WorkflowRunRecord>;
  ensureRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  readConvergedRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  runWorkflowTransaction<T>(runId: string, operation: () => Promise<T>): Promise<T>;
  sendRunMessage(input: WorkflowRouteMessageInput): Promise<WorkflowMessageRouteResult>;
  buildSnapshot(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): WorkflowRunRuntimeSnapshot;
  createRuntimeError(
    message: string,
    code: string,
    status?: number,
    hint?: string,
    details?: Record<string, unknown>
  ): Error;
}

type WorkflowTaskPipelineState = {
  runId: string;
  input: WorkflowTaskActionRequest;
  fromAgent: string;
  actionType: WorkflowTaskActionRequest["actionType"];
  currentRun: WorkflowRunRecord;
  currentRuntime: WorkflowRunRuntimeState;
  byTask: Map<string, WorkflowRunRuntimeState["tasks"][number]>;
  runTaskById: Map<string, WorkflowRunRecord["tasks"][number]>;
};

export class WorkflowTaskActionService {
  constructor(private readonly context: WorkflowTaskActionServiceContext) {}

  async applyTaskActions(
    runId: string,
    input: WorkflowTaskActionRequest
  ): Promise<Omit<WorkflowTaskActionResult, "requestId">> {
    const run = await this.context.loadRunOrThrow(runId);
    const runtime = await this.context.ensureRuntime(run);
    const actionType = input.actionType;
    const fromAgent = input.fromAgent?.trim() || "manager";

    await this.context.repositories.events.appendEvent(runId, {
      eventType: "TASK_ACTION_RECEIVED",
      source: fromAgent === "manager" ? "manager" : "agent",
      sessionId: input.fromSessionId,
      taskId: input.taskId,
      payload: {
        actionType,
        fromAgent,
        toRole: input.toRole ?? null,
        toSessionId: input.toSessionId ?? null,
        requestId: input.discuss?.requestId ?? null
      }
    });

    if (
      actionType === "TASK_DISCUSS_REQUEST" ||
      actionType === "TASK_DISCUSS_REPLY" ||
      actionType === "TASK_DISCUSS_CLOSED"
    ) {
      const message = await this.context.sendRunMessage({
        runId,
        fromAgent,
        fromSessionId: input.fromSessionId?.trim() || "manager-system",
        messageType: actionType,
        toRole: input.toRole,
        toSessionId: input.toSessionId,
        taskId: input.taskId,
        content: input.content?.trim() || "",
        requestId: input.discuss?.requestId,
        discuss: input.discuss
      });
      return {
        success: true,
        actionType,
        messageId: message.messageId,
        partialApplied: false,
        appliedTaskIds: [],
        rejectedResults: [],
        snapshot: this.context.buildSnapshot(run, runtime)
      };
    }

    return this.context.runWorkflowTransaction(runId, async () => {
      const currentRun = await this.context.loadRunOrThrow(runId);
      const currentRuntime = await this.context.readConvergedRuntime(currentRun);
      const baseState: WorkflowTaskPipelineState = {
        runId,
        input,
        fromAgent,
        actionType,
        currentRun,
        currentRuntime,
        byTask: new Map(currentRuntime.tasks.map((item) => [item.taskId, item])),
        runTaskById: new Map(currentRun.tasks.map((item) => [item.taskId, item]))
      };

      if (actionType === "TASK_CREATE") {
        return await this.applyTaskCreate(baseState);
      }
      if (actionType === "TASK_REPORT") {
        if (currentRun.status !== "running") {
          throw this.context.createRuntimeError("run is not running", "RUN_NOT_RUNNING", 409);
        }
        return await this.applyTaskReport(baseState);
      }
      throw this.context.createRuntimeError(`unsupported action_type '${actionType}'`, "INVALID_TRANSITION", 400);
    });
  }

  private async applyTaskCreate(
    state: WorkflowTaskPipelineState
  ): Promise<Omit<WorkflowTaskActionResult, "requestId">> {
    return await runOrchestratorTaskActionPipeline(state, {
      parse: async (parsedState) => {
        const task = parsedState.input.task;
        if (!task) {
          throw this.context.createRuntimeError("task payload is required", "INVALID_TRANSITION", 400);
        }
        const taskId = task.taskId?.trim() ?? "";
        if (!taskId) {
          throw this.context.createRuntimeError("task.task_id is required", "INVALID_TRANSITION", 400);
        }
        const ownerRole = task.ownerRole?.trim() ?? "";
        const taskTitle = task.title?.trim() ?? "";
        if (!taskTitle || !ownerRole) {
          throw this.context.createRuntimeError(
            "task.title and task.owner_role are required",
            "INVALID_TRANSITION",
            400
          );
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
          throw this.context.createRuntimeError(
            `task '${authorizedState.taskId}' already exists`,
            "INVALID_TRANSITION",
            409
          );
        }
        const sessions = await this.context.repositories.sessions.listSessions(authorizedState.runId);
        const roleScope = resolveWorkflowRunRoleScope(authorizedState.currentRun, sessions);
        if (!roleScope.enabledAgentSet.has(authorizedState.ownerRole)) {
          throw this.context.createRuntimeError(
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
          throw this.context.createRuntimeError(
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
            throw this.context.createRuntimeError(`dependency task '${dep}' not found`, "TASK_NOT_FOUND", 404);
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
          throw this.context.createRuntimeError(
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
            acceptance: (appliedState.task.acceptance ?? [])
              .map((item) => item.trim())
              .filter((item) => item.length > 0),
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
        await this.context.repositories.workflowRuns.writeRuntime(convergedState.runId, nextRuntime);
        const updated = await this.context.repositories.workflowRuns.patchRun(convergedState.runId, {
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
        snapshot: this.context.buildSnapshot(emittedState.updated, emittedState.nextRuntime)
      })
    });
  }

  private async applyTaskReport(
    state: WorkflowTaskPipelineState
  ): Promise<Omit<WorkflowTaskActionResult, "requestId">> {
    return await runOrchestratorTaskActionPipeline(state, {
      parse: async (parsedState) => ({
        ...parsedState,
        appliedTaskIds: [] as string[],
        rejectedResults: [] as WorkflowTaskActionResult["rejectedResults"]
      }),
      authorize: async (authorizedState) => authorizedState,
      checkDependencyGate: async (gatedState) => {
        const predictedStateByTaskId = new Map(
          gatedState.currentRuntime.tasks.map((item) => [item.taskId, item.state])
        );
        for (const result of gatedState.input.results ?? []) {
          const taskDef = gatedState.runTaskById.get(result.taskId);
          const runtimeTask = gatedState.byTask.get(result.taskId);
          if (!taskDef || !runtimeTask) {
            continue;
          }
          const target = parseOutcome(result.outcome);
          if (!target) {
            continue;
          }
          if (gatedState.fromAgent !== "manager" && taskDef.ownerRole !== gatedState.fromAgent) {
            continue;
          }
          const currentState = predictedStateByTaskId.get(result.taskId) ?? runtimeTask.state;
          if (!REPORTABLE_STATES.has(currentState)) {
            continue;
          }
          if (requiresOrchestratorReadyDependencies(target)) {
            const unresolvedDependencyTaskIds = resolveWorkflowUnreadyDependencyTaskIds(
              taskDef,
              gatedState.byTask,
              predictedStateByTaskId
            );
            if (unresolvedDependencyTaskIds.length > 0) {
              const hint =
                `Task '${result.taskId}' is blocked by dependencies [${unresolvedDependencyTaskIds.join(", ")}]. ` +
                "Wait until they are DONE/CANCELED before reporting IN_PROGRESS/DONE/MAY_BE_DONE. " +
                "If you already wrote conflicting completion claims, retract or downgrade them to draft until dependencies are ready.";
              throw this.context.createRuntimeError(
                `task '${result.taskId}' cannot transition to '${target}' before dependencies are ready: ${unresolvedDependencyTaskIds.join(", ")}`,
                "TASK_DEPENDENCY_NOT_READY",
                409,
                hint,
                {
                  task_id: result.taskId,
                  dependency_task_ids: unresolvedDependencyTaskIds,
                  current_state: currentState,
                  reported_target_state: target,
                  focus_task_id: gatedState.input.taskId ?? null
                }
              );
            }
          }
          predictedStateByTaskId.set(result.taskId, target);
        }
        return gatedState;
      },
      apply: async (appliedState) => {
        for (const result of appliedState.input.results ?? []) {
          const task = appliedState.byTask.get(result.taskId);
          if (!task) {
            appliedState.rejectedResults.push({
              taskId: result.taskId,
              reasonCode: "TASK_NOT_FOUND",
              reason: `task '${result.taskId}' not found`
            });
            continue;
          }
          const taskDef = appliedState.runTaskById.get(result.taskId);
          if (taskDef && appliedState.fromAgent !== "manager" && taskDef.ownerRole !== appliedState.fromAgent) {
            appliedState.rejectedResults.push({
              taskId: result.taskId,
              reasonCode: "INVALID_TRANSITION",
              reason: `task '${result.taskId}' is owned by '${taskDef.ownerRole}', but report was submitted by '${appliedState.fromAgent}'`
            });
            continue;
          }
          if (!REPORTABLE_STATES.has(task.state)) {
            appliedState.rejectedResults.push({
              taskId: result.taskId,
              reasonCode: "TASK_ALREADY_TERMINAL",
              reason: `task '${result.taskId}' already terminal (${task.state})`
            });
            continue;
          }
          const target = parseOutcome(result.outcome);
          if (!target) {
            appliedState.rejectedResults.push({
              taskId: result.taskId,
              reasonCode: "INVALID_TRANSITION",
              reason: `invalid outcome '${result.outcome}'`
            });
            continue;
          }
          if (target === "BLOCKED_DEP") {
            const blockers = (result.blockers ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
            task.blockedBy = blockers;
            task.blockers = blockers.length > 0 ? blockers : undefined;
            task.blockedReasons = blockers.length > 0 ? [{ code: "DEP_UNSATISFIED", dependencyTaskIds: blockers }] : [];
          } else {
            task.blockedBy = [];
            task.blockers = undefined;
            task.blockedReasons = [];
          }
          addWorkflowTaskTransition(appliedState.currentRuntime, task, target, result.summary);
          appliedState.appliedTaskIds.push(result.taskId);
          if (appliedState.input.fromSessionId) {
            await this.context.repositories.sessions
              .touchSession(appliedState.runId, appliedState.input.fromSessionId, {
                status: target === "DONE" || target === "CANCELED" ? "idle" : "running",
                currentTaskId: target === "DONE" || target === "CANCELED" ? null : result.taskId
              })
              .catch(() => {});
          }
        }
        return appliedState;
      },
      convergeRuntime: async (convergedState) => {
        const nextRuntime = convergeWorkflowRuntime(convergedState.currentRun, convergedState.currentRuntime).runtime;
        await this.context.repositories.workflowRuns.writeRuntime(convergedState.runId, nextRuntime);
        const updated = await this.context.repositories.workflowRuns.patchRun(convergedState.runId, {
          runtime: nextRuntime,
          lastHeartbeatAt: new Date().toISOString()
        });
        return {
          ...convergedState,
          nextRuntime,
          updated
        };
      },
      emit: async (emittedState) => {
        await this.context.repositories.events.appendEvent(emittedState.runId, {
          eventType: "TASK_REPORT_APPLIED",
          source: emittedState.fromAgent === "manager" ? "manager" : "agent",
          sessionId: emittedState.input.fromSessionId,
          taskId: emittedState.input.taskId,
          payload: {
            fromAgent: emittedState.fromAgent,
            actionType: emittedState.actionType,
            appliedTaskIds: emittedState.appliedTaskIds,
            updatedTaskIds: emittedState.appliedTaskIds,
            rejectedCount: emittedState.rejectedResults.length
          }
        });
        return {
          success: true,
          actionType: emittedState.actionType,
          partialApplied: emittedState.rejectedResults.length > 0,
          appliedTaskIds: emittedState.appliedTaskIds,
          rejectedResults: emittedState.rejectedResults,
          snapshot: this.context.buildSnapshot(emittedState.updated, emittedState.nextRuntime)
        };
      }
    });
  }
}
