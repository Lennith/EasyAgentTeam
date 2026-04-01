import type {
  ProjectPaths,
  ProjectRecord,
  TaskActionResult,
  TaskRecord,
  TaskReport,
  TaskState
} from "../../domain/models.js";
import type { ProjectRepositoryBundle } from "../../data/repository/project-repository-bundle.js";
import {
  buildDependencyNotReadyHint,
  isAllowedTaskReportTransition,
  normalizeTaskReport,
  requiresOrchestratorReadyDependencies,
  resolveUnreadyDependencyTaskIds
} from "./shared.js";
import { TaskActionError, type TaskReportRejectedResult } from "./types.js";
import {
  buildOrchestratorTaskReportActionResult,
  buildOrchestratorTaskReportAppliedEventPayload,
  runOrchestratorTaskActionPipeline
} from "../orchestrator/shared/index.js";
import { validateAgentProgressFile, TaskProgressValidationError } from "../task-progress-validation-service.js";
import { emitCreatorTerminalReportsIfReady } from "../task-creator-terminal-report-service.js";

export interface EvaluateTaskReportResultsInput {
  report: TaskReport;
  taskItems: TaskRecord[];
  fromAgent: string;
}

export interface EvaluateTaskReportResultsOutput {
  acceptedReport: TaskReport;
  acceptedTaskIds: string[];
  rejectedResults: TaskReportRejectedResult[];
}

export interface ApplyTaskReportActionInput {
  dataRoot: string;
  project: ProjectRecord;
  paths: ProjectPaths;
  repositories: ProjectRepositoryBundle;
  actionInput: Record<string, unknown>;
  requestId: string;
  fromAgent: string;
  fromSessionId: string;
}

interface TaskReportPipelineState extends ApplyTaskReportActionInput {
  report: TaskReport;
  acceptedTaskIds: string[];
  acceptedReport: TaskReport;
  rejectedResults: TaskReportRejectedResult[];
  resolvedTaskId: string | undefined;
}

export function evaluateTaskReportResults(input: EvaluateTaskReportResultsInput): EvaluateTaskReportResultsOutput {
  const byId = new Map(input.taskItems.map((task) => [task.taskId, task]));
  const predictedStateByTaskId = new Map(input.taskItems.map((task) => [task.taskId, task.state]));

  const acceptedResults: TaskReport["results"] = [];
  const rejectedResults: TaskReportRejectedResult[] = [];
  for (const result of input.report.results) {
    const target = byId.get(result.taskId);
    if (!target) {
      rejectedResults.push({
        task_id: result.taskId,
        reason_code: "TASK_RESULT_INVALID_TARGET",
        reason: `task '${result.taskId}' not found`
      });
      continue;
    }

    const authorized = target.ownerRole === input.fromAgent || target.creatorRole === input.fromAgent;
    if (!authorized) {
      rejectedResults.push({
        task_id: result.taskId,
        reason_code: "TASK_RESULT_INVALID_TARGET",
        reason: `task '${result.taskId}' is neither owned nor created by ${input.fromAgent}`
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
    if (!isAllowedTaskReportTransition(currentState, nextState as TaskState)) {
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
    predictedStateByTaskId.set(target.taskId, nextState as TaskState);
  }

  if (acceptedResults.length === 0) {
    const onlyStale =
      rejectedResults.length > 0 && rejectedResults.every((item) => item.reason_code === "TASK_STATE_STALE");
    throw new TaskActionError(
      onlyStale ? "TASK_REPORT transition is stale for all reported tasks" : "TASK_REPORT has no acceptable results",
      onlyStale ? "TASK_STATE_STALE" : "TASK_RESULT_INVALID_TARGET",
      409,
      {
        reportId: input.report.reportId,
        rejectedResults
      }
    );
  }

  return {
    acceptedReport: {
      ...input.report,
      results: acceptedResults
    },
    acceptedTaskIds: acceptedResults.map((item) => item.taskId),
    rejectedResults
  };
}

export async function applyTaskReportAction(input: ApplyTaskReportActionInput): Promise<TaskActionResult> {
  return await runOrchestratorTaskActionPipeline(input, {
    parse: async (state) => {
      const report = normalizeTaskReport(
        state.project.projectId,
        state.fromSessionId,
        state.fromAgent,
        state.actionInput
      );
      return {
        ...state,
        report
      };
    },
    authorize: async (state) => {
      const taskItems = await state.repositories.taskboard.listTasks(state.paths, state.project.projectId);
      const evaluated = evaluateTaskReportResults({
        report: state.report,
        taskItems,
        fromAgent: state.fromAgent
      });
      return {
        ...state,
        acceptedTaskIds: evaluated.acceptedTaskIds,
        acceptedReport: evaluated.acceptedReport,
        rejectedResults: evaluated.rejectedResults
      };
    },
    checkDependencyGate: async (state) => {
      try {
        await validateAgentProgressFile(state.project, state.fromAgent, state.acceptedReport, {
          resultTaskIds: state.acceptedTaskIds
        });
      } catch (error) {
        if (error instanceof TaskProgressValidationError) {
          await state.repositories.events.appendEvent(state.paths, {
            projectId: state.project.projectId,
            eventType: "TASK_PROGRESS_VALIDATION_FAILED",
            source: "manager",
            sessionId: state.fromSessionId,
            payload: {
              requestId: state.requestId,
              fromAgent: state.fromAgent,
              reason: error.message,
              acceptedTaskIds: state.acceptedTaskIds
            }
          });
          throw new TaskActionError(error.message, "TASK_PROGRESS_REQUIRED");
        }
        throw error;
      }
      return state;
    },
    apply: async (state) => {
      const update = await state.repositories.taskboard.updateTaskboardFromTaskReport(
        state.paths,
        state.project.projectId,
        state.acceptedReport
      );
      const resolvedTaskId = state.report.parentTaskId ?? state.report.results[0]?.taskId;
      const reportAppliedPayload = buildOrchestratorTaskReportAppliedEventPayload({
        fromAgent: state.fromAgent,
        appliedTaskIds: state.acceptedTaskIds,
        rejectedResults: state.rejectedResults,
        includeRejectedResults: true,
        extraPayload: {
          requestId: state.requestId,
          toRole: "manager",
          reportId: state.report.reportId,
          parentTaskId: state.report.parentTaskId ?? null,
          appliedCount: state.acceptedTaskIds.length
        }
      });
      await state.repositories.events.appendEvent(state.paths, {
        projectId: state.project.projectId,
        eventType: "TASK_REPORT_APPLIED",
        source: "manager",
        sessionId: state.fromSessionId,
        taskId: resolvedTaskId,
        payload: {
          ...reportAppliedPayload,
          updatedTaskIds: update.updatedTaskIds
        }
      });
      await emitCreatorTerminalReportsIfReady(state.dataRoot, state.project, state.paths, state.requestId);
      return {
        ...state,
        resolvedTaskId
      };
    },
    convergeRuntime: async (state) => state,
    emit: async (state: TaskReportPipelineState): Promise<TaskActionResult> =>
      buildOrchestratorTaskReportActionResult({
        actionType: "TASK_REPORT",
        appliedTaskIds: state.acceptedTaskIds,
        rejectedResults: state.rejectedResults,
        extraResult: {
          requestId: state.requestId,
          taskId: state.resolvedTaskId
        }
      })
  });
}
