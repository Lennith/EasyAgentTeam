import fs from "node:fs/promises";
import type {
  WorkflowRunEventRecord,
  WorkflowRunRecord,
  WorkflowRunRuntimeState,
  WorkflowSessionRecord,
  WorkflowTaskRuntimeRecord
} from "../../domain/models.js";
import type { WorkflowRepositoryBundle } from "../../data/repository/workflow-repository-bundle.js";
import { logger } from "../../utils/logger.js";
import { readPayloadString } from "./dispatch-engine.js";
import { evaluateWorkflowAutoFinishWindow } from "./runtime/workflow-auto-finish-window.js";
import { addWorkflowTaskTransition, isWorkflowTaskTerminalState } from "./runtime/workflow-runtime-kernel.js";
import { buildOrchestratorAgentProgressFile } from "./shared/orchestrator-runtime-helpers.js";

const MAY_BE_DONE_DISPATCH_THRESHOLD = 5;
const MAY_BE_DONE_CHECK_WINDOW_MS = 60 * 60 * 1000;
const AUTO_FINISH_STABLE_TICKS_REQUIRED = 2;

interface WorkflowCompletionServiceContext {
  repositories: WorkflowRepositoryBundle;
  runAutoFinishStableTicks: Map<string, number>;
  onRunFinished(runId: string): void;
  loadRunOrThrow(runId: string): Promise<WorkflowRunRecord>;
  readConvergedRuntime(run: WorkflowRunRecord): Promise<WorkflowRunRuntimeState>;
  runWorkflowTransaction<T>(runId: string, operation: () => Promise<T>): Promise<T>;
}

export class WorkflowCompletionService {
  constructor(private readonly context: WorkflowCompletionServiceContext) {}

  async checkAndMarkMayBeDone(run: WorkflowRunRecord, runtime: WorkflowRunRuntimeState): Promise<void> {
    const mayBeDoneEnabled = String(process.env.MAY_BE_DONE_ENABLED ?? "1").trim() !== "0";
    if (!mayBeDoneEnabled) {
      return;
    }

    const thresholdRaw = Number(process.env.MAY_BE_DONE_DISPATCH_THRESHOLD ?? MAY_BE_DONE_DISPATCH_THRESHOLD);
    const threshold =
      Number.isFinite(thresholdRaw) && thresholdRaw > 0 ? Math.floor(thresholdRaw) : MAY_BE_DONE_DISPATCH_THRESHOLD;
    const windowRaw = Number(process.env.MAY_BE_DONE_CHECK_WINDOW_MS ?? MAY_BE_DONE_CHECK_WINDOW_MS);
    const windowMs = Number.isFinite(windowRaw) && windowRaw > 0 ? Math.floor(windowRaw) : MAY_BE_DONE_CHECK_WINDOW_MS;

    const nonTerminalTasks = runtime.tasks.filter((task) => task.state !== "DONE" && task.state !== "CANCELED");
    if (nonTerminalTasks.length === 0) {
      return;
    }

    const events = await this.context.repositories.events.listEvents(run.runId);
    const cutoff = Date.now() - windowMs;
    const recentEvents = events.filter((event) => Date.parse(event.createdAt) >= cutoff);

    let changed = false;
    const eventsToAppend: Array<{ taskId: string; dispatchCount: number }> = [];
    for (const task of nonTerminalTasks) {
      if (task.state === "MAY_BE_DONE") {
        continue;
      }
      const taskDispatchEvents = recentEvents.filter((event) => {
        if (event.taskId !== task.taskId || event.eventType !== "ORCHESTRATOR_DISPATCH_STARTED") {
          return false;
        }
        const payload = event.payload as Record<string, unknown>;
        return readPayloadString(payload, "dispatchKind") === "task";
      });
      const dispatchCount = taskDispatchEvents.length;
      if (dispatchCount < threshold) {
        continue;
      }
      const hasValidOutput = await this.hasValidAgentOutput(run, task, recentEvents);
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

    await this.context.runWorkflowTransaction(run.runId, async () => {
      const freshRun = await this.context.loadRunOrThrow(run.runId);
      const latestRuntime = await this.context.readConvergedRuntime(freshRun);
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
      await this.context.repositories.workflowRuns.writeRuntime(run.runId, latestRuntime);
      await this.context.repositories.workflowRuns.patchRun(run.runId, { runtime: latestRuntime });
      for (const item of appliedEvents) {
        await this.context.repositories.events.appendEvent(run.runId, {
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

  async checkAndFinalizeRunByStableWindow(
    run: WorkflowRunRecord,
    runtime: WorkflowRunRuntimeState,
    sessions: WorkflowSessionRecord[]
  ): Promise<boolean> {
    const unfinishedTaskCount = this.countUnfinishedTasks(runtime);
    const runningSessionCount = this.countRunningSessions(sessions);
    const evaluated = evaluateWorkflowAutoFinishWindow({
      previousStableTicks: this.context.runAutoFinishStableTicks.get(run.runId) ?? 0,
      unfinishedTaskCount,
      runningSessionCount,
      requiredStableTicks: AUTO_FINISH_STABLE_TICKS_REQUIRED
    });

    if (!evaluated.eligible) {
      if (evaluated.reset) {
        this.context.runAutoFinishStableTicks.set(run.runId, 0);
        await this.context.repositories.events.appendEvent(run.runId, {
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
    this.context.runAutoFinishStableTicks.set(run.runId, stableTicks);
    await this.context.repositories.events.appendEvent(run.runId, {
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
    await this.context.runWorkflowTransaction(run.runId, async () => {
      const finalizedRuntime: WorkflowRunRuntimeState = {
        ...runtime,
        updatedAt: now
      };
      await this.context.repositories.workflowRuns.writeRuntime(run.runId, finalizedRuntime);
      await this.context.repositories.workflowRuns.patchRun(run.runId, {
        runtime: finalizedRuntime,
        status: "finished",
        stoppedAt: now,
        lastHeartbeatAt: now
      });
      await this.context.repositories.events.appendEvent(run.runId, {
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
    this.context.onRunFinished(run.runId);
    return true;
  }

  private countUnfinishedTasks(runtime: WorkflowRunRuntimeState): number {
    return runtime.tasks.reduce((count, task) => (isWorkflowTaskTerminalState(task.state) ? count : count + 1), 0);
  }

  private countRunningSessions(sessions: WorkflowSessionRecord[]): number {
    return sessions.reduce((count, session) => (session.status === "running" ? count + 1 : count), 0);
  }

  private async hasValidAgentOutput(
    run: WorkflowRunRecord,
    task: WorkflowTaskRuntimeRecord,
    recentEvents: WorkflowRunEventRecord[]
  ): Promise<boolean> {
    if (task.lastSummary && task.lastSummary.trim().length > 0) {
      return true;
    }

    const runFinishedEvents = recentEvents.filter(
      (event) =>
        event.taskId === task.taskId &&
        (event.eventType === "CODEX_RUN_FINISHED" || event.eventType === "MINIMAX_RUN_FINISHED")
    );
    for (const event of runFinishedEvents) {
      const payload = event.payload as Record<string, unknown>;
      const exitCode = payload.exitCode;
      if (typeof exitCode === "number" && exitCode === 0) {
        return true;
      }
    }

    const ownerRole = run.tasks.find((item) => item.taskId === task.taskId)?.ownerRole?.trim();
    if (ownerRole) {
      const progressFile = buildOrchestratorAgentProgressFile(run.workspacePath, ownerRole);
      try {
        const content = await fs.readFile(progressFile, "utf8");
        const normalized = content.replace(/^\uFEFF/, "").trim();
        if (normalized.length > 50) {
          return true;
        }
      } catch {
        // File doesn't exist or can't be read.
      }
    }

    return false;
  }
}
