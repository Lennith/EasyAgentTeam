import type { WorkflowRunRecord, WorkflowRunRuntimeState, WorkflowSessionRecord } from "../../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../../data/repository/workflow/repository-bundle.js";
import { evaluateWorkflowAutoFinishWindow } from "../shared/runtime/workflow-auto-finish-window.js";
import { isWorkflowTaskTerminalState } from "../shared/runtime/workflow-runtime-kernel.js";

const AUTO_FINISH_STABLE_TICKS_REQUIRED = 2;

export interface WorkflowCompletionFinalizeContext {
  repositories: WorkflowRepositoryBundle;
  runAutoFinishStableTicks: Map<string, number>;
  onRunFinished(runId: string): void;
  runWorkflowTransaction<T>(runId: string, operation: () => Promise<T>): Promise<T>;
}

function countUnfinishedTasks(runtime: WorkflowRunRuntimeState): number {
  return runtime.tasks.reduce((count, task) => (isWorkflowTaskTerminalState(task.state) ? count : count + 1), 0);
}

function countRunningSessions(sessions: WorkflowSessionRecord[]): number {
  return sessions.reduce((count, session) => (session.status === "running" ? count + 1 : count), 0);
}

export async function checkAndFinalizeWorkflowRunByStableWindow(
  context: WorkflowCompletionFinalizeContext,
  run: WorkflowRunRecord,
  runtime: WorkflowRunRuntimeState,
  sessions: WorkflowSessionRecord[]
): Promise<boolean> {
  const unfinishedTaskCount = countUnfinishedTasks(runtime);
  const runningSessionCount = countRunningSessions(sessions);
  const evaluated = evaluateWorkflowAutoFinishWindow({
    previousStableTicks: context.runAutoFinishStableTicks.get(run.runId) ?? 0,
    unfinishedTaskCount,
    runningSessionCount,
    requiredStableTicks: AUTO_FINISH_STABLE_TICKS_REQUIRED
  });

  if (!evaluated.eligible) {
    if (evaluated.reset) {
      context.runAutoFinishStableTicks.set(run.runId, 0);
      await context.repositories.events.appendEvent(run.runId, {
        eventType: "ORCHESTRATOR_RUN_AUTO_FINISH_WINDOW_RESET",
        source: "system",
        payload: {
          previousStableTicks: evaluated.previousStableTicks,
          stableTicks: 0,
          requiredStableTicks: AUTO_FINISH_STABLE_TICKS_REQUIRED,
          unfinishedTaskCount,
          runningSessionCount
        }
      });
    }
    return false;
  }

  const stableTicks = evaluated.stableTicks;
  context.runAutoFinishStableTicks.set(run.runId, stableTicks);
  await context.repositories.events.appendEvent(run.runId, {
    eventType: "ORCHESTRATOR_RUN_AUTO_FINISH_WINDOW_TICK",
    source: "system",
    payload: {
      stableTicks,
      requiredStableTicks: AUTO_FINISH_STABLE_TICKS_REQUIRED,
      unfinishedTaskCount,
      runningSessionCount
    }
  });

  if (!evaluated.shouldFinalize) {
    return false;
  }

  const now = new Date().toISOString();
  await context.runWorkflowTransaction(run.runId, async () => {
    const finalizedRuntime: WorkflowRunRuntimeState = {
      ...runtime,
      updatedAt: now
    };
    await context.repositories.workflowRuns.writeRuntime(run.runId, finalizedRuntime);
    await context.repositories.workflowRuns.patchRun(run.runId, {
      runtime: finalizedRuntime,
      status: "finished",
      stoppedAt: now,
      lastHeartbeatAt: now
    });
    await context.repositories.events.appendEvent(run.runId, {
      eventType: "ORCHESTRATOR_RUN_AUTO_FINISHED",
      source: "system",
      payload: {
        stableTicks,
        requiredStableTicks: AUTO_FINISH_STABLE_TICKS_REQUIRED,
        unfinishedTaskCount,
        runningSessionCount,
        finishedAt: now
      }
    });
  });
  context.onRunFinished(run.runId);
  return true;
}
