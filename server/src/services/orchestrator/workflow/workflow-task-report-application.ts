import type {
  WorkflowRunRecord,
  WorkflowRunRuntimeSnapshot,
  WorkflowRunRuntimeState,
  WorkflowTaskActionResult
} from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { addWorkflowTaskTransition, convergeWorkflowRuntime } from "../shared/runtime/workflow-runtime-kernel.js";
import {
  buildOrchestratorTaskReportActionResult,
  buildOrchestratorTaskReportAppliedEventPayload,
  isOrchestratorTaskReportableState,
  parseOrchestratorTaskReportOutcome
} from "../shared/index.js";
import type { WorkflowTaskReportMutableState } from "./workflow-task-report-guard.js";

export type WorkflowTaskReportConvergedState = WorkflowTaskReportMutableState & {
  nextRuntime: WorkflowRunRuntimeState;
  updated: WorkflowRunRecord;
};

interface WorkflowTaskReportResultContext {
  repositories: WorkflowRepositoryBundle;
  buildSnapshot(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): WorkflowRunRuntimeSnapshot;
}

export async function applyWorkflowTaskReportMutation<TState extends WorkflowTaskReportMutableState>(
  state: TState,
  _repositories: WorkflowRepositoryBundle
): Promise<TState> {
  for (const result of state.input.results ?? []) {
    const task = state.byTask.get(result.taskId);
    if (!task) {
      state.rejectedResults.push({
        taskId: result.taskId,
        reasonCode: "TASK_NOT_FOUND",
        reason: `task '${result.taskId}' not found`
      });
      continue;
    }
    const taskDef = state.runTaskById.get(result.taskId);
    if (taskDef && state.fromAgent !== "manager" && taskDef.ownerRole !== state.fromAgent) {
      state.rejectedResults.push({
        taskId: result.taskId,
        reasonCode: "INVALID_TRANSITION",
        reason: `task '${result.taskId}' is owned by '${taskDef.ownerRole}', but report was submitted by '${state.fromAgent}'`
      });
      continue;
    }
    if (!isOrchestratorTaskReportableState(task.state)) {
      state.rejectedResults.push({
        taskId: result.taskId,
        reasonCode: "TASK_ALREADY_TERMINAL",
        reason: `task '${result.taskId}' already terminal (${task.state})`
      });
      continue;
    }
    const target = parseOrchestratorTaskReportOutcome(result.outcome, { allowMayBeDone: true });
    if (!target) {
      state.rejectedResults.push({
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
    addWorkflowTaskTransition(state.currentRuntime, task, target, result.summary);
    state.appliedTaskIds.push(result.taskId);
  }
  return state;
}

export async function convergeWorkflowTaskReportRuntime<TState extends WorkflowTaskReportMutableState>(
  state: TState,
  repositories: WorkflowRepositoryBundle
): Promise<WorkflowTaskReportConvergedState> {
  const nextRuntime = convergeWorkflowRuntime(state.currentRun, state.currentRuntime).runtime;
  await repositories.workflowRuns.writeRuntime(state.runId, nextRuntime);
  const updated = await repositories.workflowRuns.patchRun(state.runId, {
    runtime: nextRuntime,
    lastHeartbeatAt: new Date().toISOString()
  });
  return {
    ...state,
    nextRuntime,
    updated
  };
}

export async function emitWorkflowTaskReportResult(
  state: WorkflowTaskReportConvergedState,
  context: WorkflowTaskReportResultContext
): Promise<Omit<WorkflowTaskActionResult, "requestId">> {
  const reportAppliedPayload = buildOrchestratorTaskReportAppliedEventPayload({
    fromAgent: state.fromAgent,
    appliedTaskIds: state.appliedTaskIds,
    rejectedResults: state.rejectedResults,
    extraPayload: {
      actionType: state.actionType
    }
  });
  await context.repositories.events.appendEvent(state.runId, {
    eventType: "TASK_REPORT_APPLIED",
    source: state.fromAgent === "manager" ? "manager" : "agent",
    sessionId: state.input.fromSessionId,
    taskId: state.input.taskId,
    payload: reportAppliedPayload
  });
  return buildOrchestratorTaskReportActionResult({
    actionType: state.actionType,
    appliedTaskIds: state.appliedTaskIds,
    rejectedResults: state.rejectedResults,
    extraResult: {
      snapshot: context.buildSnapshot(state.updated, state.nextRuntime)
    }
  });
}
