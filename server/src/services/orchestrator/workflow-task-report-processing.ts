import type {
  WorkflowRunRecord,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeState,
  WorkflowTaskActionResult
} from "../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import type { WorkflowTaskActionPipelineState } from "./workflow-task-action-types.js";
import {
  addWorkflowTaskTransition,
  convergeWorkflowRuntime,
  resolveWorkflowUnreadyDependencyTaskIds
} from "./runtime/workflow-runtime-kernel.js";
import {
  buildOrchestratorTaskReportActionResult,
  buildOrchestratorTaskReportAppliedEventPayload,
  buildOrchestratorDependencyNotReadyHint,
  isOrchestratorTaskReportableState,
  parseOrchestratorTaskReportOutcome,
  requiresOrchestratorReadyDependencies,
  runOrchestratorTaskActionPipeline
} from "./shared/index.js";

export type WorkflowTaskReportPipelineState = WorkflowTaskActionPipelineState;

export interface ApplyWorkflowTaskReportActionInput {
  state: WorkflowTaskReportPipelineState;
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

export async function applyWorkflowTaskReportAction(
  input: ApplyWorkflowTaskReportActionInput
): Promise<Omit<WorkflowTaskActionResult, "requestId">> {
  return await runOrchestratorTaskActionPipeline(input.state, {
    parse: async (parsedState) => ({
      ...parsedState,
      appliedTaskIds: [] as string[],
      rejectedResults: [] as WorkflowTaskActionResult["rejectedResults"]
    }),
    authorize: async (authorizedState) => authorizedState,
    checkDependencyGate: async (gatedState) => {
      const predictedStateByTaskId = new Map(gatedState.currentRuntime.tasks.map((item) => [item.taskId, item.state]));
      for (const result of gatedState.input.results ?? []) {
        const taskDef = gatedState.runTaskById.get(result.taskId);
        const runtimeTask = gatedState.byTask.get(result.taskId);
        if (!taskDef || !runtimeTask) {
          continue;
        }
        const target = parseOrchestratorTaskReportOutcome(result.outcome, { allowMayBeDone: true });
        if (!target) {
          continue;
        }
        if (gatedState.fromAgent !== "manager" && taskDef.ownerRole !== gatedState.fromAgent) {
          continue;
        }
        const currentState = predictedStateByTaskId.get(result.taskId) ?? runtimeTask.state;
        if (!isOrchestratorTaskReportableState(currentState)) {
          continue;
        }
        if (requiresOrchestratorReadyDependencies(target)) {
          const unresolvedDependencyTaskIds = resolveWorkflowUnreadyDependencyTaskIds(
            taskDef,
            gatedState.byTask,
            predictedStateByTaskId
          );
          if (unresolvedDependencyTaskIds.length > 0) {
            throw input.createRuntimeError(
              `task '${result.taskId}' cannot transition to '${target}' before dependencies are ready: ${unresolvedDependencyTaskIds.join(", ")}`,
              "TASK_DEPENDENCY_NOT_READY",
              409,
              buildOrchestratorDependencyNotReadyHint(result.taskId, unresolvedDependencyTaskIds),
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
        if (!isOrchestratorTaskReportableState(task.state)) {
          appliedState.rejectedResults.push({
            taskId: result.taskId,
            reasonCode: "TASK_ALREADY_TERMINAL",
            reason: `task '${result.taskId}' already terminal (${task.state})`
          });
          continue;
        }
        const target = parseOrchestratorTaskReportOutcome(result.outcome, { allowMayBeDone: true });
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
          await input.repositories.sessions
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
      await input.repositories.workflowRuns.writeRuntime(convergedState.runId, nextRuntime);
      const updated = await input.repositories.workflowRuns.patchRun(convergedState.runId, {
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
      const reportAppliedPayload = buildOrchestratorTaskReportAppliedEventPayload({
        fromAgent: emittedState.fromAgent,
        appliedTaskIds: emittedState.appliedTaskIds,
        rejectedResults: emittedState.rejectedResults,
        extraPayload: {
          actionType: emittedState.actionType
        }
      });
      await input.repositories.events.appendEvent(emittedState.runId, {
        eventType: "TASK_REPORT_APPLIED",
        source: emittedState.fromAgent === "manager" ? "manager" : "agent",
        sessionId: emittedState.input.fromSessionId,
        taskId: emittedState.input.taskId,
        payload: reportAppliedPayload
      });
      return buildOrchestratorTaskReportActionResult({
        actionType: emittedState.actionType,
        appliedTaskIds: emittedState.appliedTaskIds,
        rejectedResults: emittedState.rejectedResults,
        extraResult: {
          snapshot: input.buildSnapshot(emittedState.updated, emittedState.nextRuntime)
        }
      });
    }
  });
}
