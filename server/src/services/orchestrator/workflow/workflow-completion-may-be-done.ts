import fs from "node:fs/promises";
import type {
  WorkflowRunEventRecord,
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowTaskRuntimeRecord
} from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { logger } from "../../../utils/logger.js";
import { addWorkflowTaskTransition, isWorkflowTaskTerminalState } from "../shared/runtime/workflow-runtime-kernel.js";
import { buildOrchestratorAgentProgressFile } from "../shared/orchestrator-runtime-helpers.js";
import {
  countOrchestratorTaskDispatches,
  hasOrchestratorSuccessfulRunFinishEvent,
  isOrchestratorTerminalTaskState,
  isOrchestratorValidProgressContent,
  resolveOrchestratorMayBeDoneSettings
} from "../shared/index.js";

export interface WorkflowCompletionMayBeDoneContext {
  repositories: WorkflowRepositoryBundle;
  loadRunOrThrow(runId: string): Promise<WorkflowRunRecord>;
  readConvergedRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  runWorkflowTransaction<T>(runId: string, operation: () => Promise<T>): Promise<T>;
}

async function hasWorkflowValidAgentOutput(
  run: WorkflowRunRecord,
  task: WorkflowTaskRuntimeRecord,
  recentEvents: WorkflowRunEventRecord[]
): Promise<boolean> {
  if (task.lastSummary && task.lastSummary.trim().length > 0) {
    return true;
  }

  if (hasOrchestratorSuccessfulRunFinishEvent(task.taskId, recentEvents)) {
    return true;
  }

  const ownerRole = run.tasks.find((item) => item.taskId === task.taskId)?.ownerRole?.trim();
  if (!ownerRole) {
    return false;
  }
  try {
    const progressFile = buildOrchestratorAgentProgressFile(run.workspacePath, ownerRole);
    const content = await fs.readFile(progressFile, "utf8");
    return isOrchestratorValidProgressContent(content);
  } catch {
    return false;
  }
}

export async function checkWorkflowTasksMayBeDone(
  context: WorkflowCompletionMayBeDoneContext,
  run: WorkflowRunRecord,
  runtime: WorkflowRunRuntimeState
): Promise<void> {
  const mayBeDoneSettings = resolveOrchestratorMayBeDoneSettings();
  if (!mayBeDoneSettings.enabled) {
    return;
  }
  const { threshold, windowMs } = mayBeDoneSettings;

  const nonTerminalTasks = runtime.tasks.filter((task) => !isOrchestratorTerminalTaskState(task.state));
  if (nonTerminalTasks.length === 0) {
    return;
  }

  const events = await context.repositories.events.listEvents(run.runId);
  const cutoff = Date.now() - windowMs;
  const recentEvents = events.filter((event) => Date.parse(event.createdAt) >= cutoff);

  let changed = false;
  const eventsToAppend: Array<{ taskId: string; dispatchCount: number }> = [];
  for (const task of nonTerminalTasks) {
    if (task.state === "MAY_BE_DONE") {
      continue;
    }
    const dispatchCount = countOrchestratorTaskDispatches(task.taskId, recentEvents);
    if (dispatchCount < threshold) {
      continue;
    }
    const hasValidOutput = await hasWorkflowValidAgentOutput(run, task, recentEvents);
    if (!hasValidOutput) {
      continue;
    }

    addWorkflowTaskTransition(runtime, task, "MAY_BE_DONE");
    eventsToAppend.push({ taskId: task.taskId, dispatchCount });
    logger.info(
      `[workflow-completion-service] checkAndMarkMayBeDone: runId=${run.runId}, taskId=${task.taskId}, dispatchCount=${dispatchCount}`
    );
    changed = true;
  }

  if (!changed) {
    return;
  }

  await context.runWorkflowTransaction(run.runId, async () => {
    const freshRun = await context.loadRunOrThrow(run.runId);
    const latestRuntime = await context.readConvergedRuntime(freshRun);
    const latestByTask = new Map(latestRuntime.tasks.map((item) => [item.taskId, item]));
    const appliedEvents: Array<{ taskId: string; dispatchCount: number }> = [];
    for (const item of eventsToAppend) {
      const task = latestByTask.get(item.taskId);
      if (!task || isWorkflowTaskTerminalState(task.state) || task.state === "MAY_BE_DONE") {
        continue;
      }
      addWorkflowTaskTransition(latestRuntime, task, "MAY_BE_DONE");
      appliedEvents.push(item);
    }
    if (appliedEvents.length === 0) {
      return;
    }
    await context.repositories.workflowRuns.writeRuntime(run.runId, latestRuntime);
    await context.repositories.workflowRuns.patchRun(run.runId, { runtime: latestRuntime });
    for (const item of appliedEvents) {
      await context.repositories.events.appendEvent(run.runId, {
        eventType: "TASK_MAY_BE_DONE_MARKED",
        source: "system",
        taskId: item.taskId,
        payload: {
          dispatchCount: item.dispatchCount,
          threshold,
          windowMs,
          reason: "dispatch_threshold_exceeded_with_valid_output"
        }
      });
    }
  });
}
