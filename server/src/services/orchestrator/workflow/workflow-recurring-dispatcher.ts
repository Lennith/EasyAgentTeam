import { randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { OrchestratorLoopCore } from "../../orchestrator-core.js";
import {
  getWorkflowRepositoryBundle,
  type WorkflowRepositoryBundle
} from "../../../data/repository/workflow/repository-bundle.js";
import type {
  WorkflowRunMode,
  WorkflowRunRecord,
  WorkflowRunSpawnState,
  WorkflowRunTaskRecord
} from "../../../domain/models.js";
import { logger } from "../../../utils/logger.js";
import type { WorkflowOrchestratorService } from "./workflow-orchestrator.js";
import {
  buildWorkflowScheduleWindowKey,
  computeNextWorkflowScheduleTriggerAt,
  matchesWorkflowSchedulePattern,
  parseWorkflowScheduleExpression,
  resolveWorkflowScheduleWindowRange
} from "./workflow-recurring-schedule.js";

export interface WorkflowRecurringDispatcherOptions {
  enabled: boolean;
  intervalMs: number;
}

const RECURRING_SOURCE_LOCK_HEARTBEAT_MS = 1000;
const RECURRING_SOURCE_LOCK_STALE_MS = 30 * 1000;
const RECURRING_SOURCE_LOCK_DIR = ".recurring-dispatcher-locks";

interface RecurringSourceLease {
  active: boolean;
  handle: FileHandle;
  heartbeat: NodeJS.Timeout | null;
  heartbeatTail: Promise<void>;
  lockPath: string;
  token: string;
}

function resolveBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

function resolveIntervalMs(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 10000) {
    return fallback;
  }
  return parsed;
}

export function resolveWorkflowRecurringDispatcherOptionsFromEnv(): WorkflowRecurringDispatcherOptions {
  return {
    enabled: resolveBooleanEnv(process.env.WORKFLOW_RECURRING_DISPATCHER_ENABLED, true),
    intervalMs: resolveIntervalMs(process.env.WORKFLOW_RECURRING_DISPATCHER_INTERVAL_MS, 60000)
  };
}

function resolveRecurringMode(
  run: Pick<WorkflowRunRecord, "mode" | "loopEnabled" | "scheduleEnabled">
): WorkflowRunMode {
  if (run.mode === "loop" || run.mode === "schedule") {
    return run.mode;
  }
  if (run.scheduleEnabled) {
    return "schedule";
  }
  if (run.loopEnabled) {
    return "loop";
  }
  return "none";
}

function cloneRunTasks(tasks: WorkflowRunTaskRecord[]): WorkflowRunTaskRecord[] {
  return tasks.map((task) => ({
    ...task,
    dependencies: task.dependencies ? [...task.dependencies] : undefined,
    writeSet: task.writeSet ? [...task.writeSet] : undefined,
    acceptance: task.acceptance ? [...task.acceptance] : undefined,
    artifacts: task.artifacts ? [...task.artifacts] : undefined
  }));
}

function cloneRouteMap(table: Record<string, string[]> | undefined): Record<string, string[]> | undefined {
  if (!table) {
    return undefined;
  }
  const next: Record<string, string[]> = {};
  for (const [from, values] of Object.entries(table)) {
    next[from] = [...values];
  }
  return next;
}

function cloneDiscussRounds(
  rounds: Record<string, Record<string, number>> | undefined
): Record<string, Record<string, number>> | undefined {
  if (!rounds) {
    return undefined;
  }
  const next: Record<string, Record<string, number>> = {};
  for (const [from, values] of Object.entries(rounds)) {
    next[from] = { ...values };
  }
  return next;
}

function cloneStringMap(values: Record<string, string> | undefined): Record<string, string> | undefined {
  return values ? { ...values } : undefined;
}

function normalizeSpawnState(raw: WorkflowRunSpawnState | undefined): WorkflowRunSpawnState {
  return raw ? { ...raw } : {};
}

function isSpawnStateEqual(left: WorkflowRunSpawnState | undefined, right: WorkflowRunSpawnState | undefined): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

async function isRecurringSourceLeaseStale(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(lockPath);
    return Date.now() - stat.mtimeMs > RECURRING_SOURCE_LOCK_STALE_MS;
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function buildRecurringSourceLeaseContent(token: string): string {
  return `${JSON.stringify({
    pid: process.pid,
    token,
    heartbeatAt: new Date().toISOString()
  })}\n`;
}

async function refreshRecurringSourceLease(lease: RecurringSourceLease): Promise<void> {
  const payload = Buffer.from(buildRecurringSourceLeaseContent(lease.token), "utf8");
  await lease.handle.truncate(0);
  await lease.handle.write(payload, 0, payload.byteLength, 0);
  await lease.handle.sync();
}

async function readRecurringSourceLeaseToken(lockPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { token?: unknown };
    return typeof parsed.token === "string" && parsed.token.trim().length > 0 ? parsed.token.trim() : null;
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function isRecurringSourceLeaseActive(lease: RecurringSourceLease): Promise<boolean> {
  return (await readRecurringSourceLeaseToken(lease.lockPath)) === lease.token;
}

async function tryAcquireRecurringSourceLease(lockPath: string): Promise<RecurringSourceLease | null> {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const lease: RecurringSourceLease = {
        active: true,
        handle,
        heartbeat: null,
        heartbeatTail: Promise.resolve(),
        lockPath,
        token: randomUUID()
      };
      await refreshRecurringSourceLease(lease);
      lease.heartbeat = setInterval(() => {
        if (!lease.active) {
          return;
        }
        lease.heartbeatTail = lease.heartbeatTail.then(async () => {
          if (!lease.active) {
            return;
          }
          await refreshRecurringSourceLease(lease);
        });
      }, RECURRING_SOURCE_LOCK_HEARTBEAT_MS);
      lease.heartbeat.unref?.();
      return lease;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code !== "EEXIST") {
        throw error;
      }
      if (!(await isRecurringSourceLeaseStale(lockPath))) {
        return null;
      }
      try {
        await fs.rm(lockPath);
      } catch (removeError) {
        const removeKnown = removeError as NodeJS.ErrnoException;
        if (removeKnown.code === "ENOENT") {
          continue;
        }
        if (removeKnown.code === "EPERM" || removeKnown.code === "EACCES") {
          return null;
        }
        throw removeError;
      }
    }
  }
}

async function releaseRecurringSourceLease(lease: RecurringSourceLease): Promise<void> {
  lease.active = false;
  if (lease.heartbeat) {
    clearInterval(lease.heartbeat);
  }
  try {
    await lease.heartbeatTail.catch(() => {});
  } catch (error) {
    void error;
  }
  try {
    await lease.handle.close();
  } catch (error) {
    void error;
  }
  try {
    if (await isRecurringSourceLeaseActive(lease)) {
      await fs.rm(lease.lockPath, { force: true });
    }
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code !== "ENOENT") {
      throw error;
    }
  }
}

export class WorkflowRecurringDispatcherService {
  private readonly repositories: WorkflowRepositoryBundle;
  private readonly loopCore: OrchestratorLoopCore;

  constructor(
    private readonly dataRoot: string,
    private readonly workflowOrchestrator: WorkflowOrchestratorService,
    options: WorkflowRecurringDispatcherOptions
  ) {
    this.repositories = getWorkflowRepositoryBundle(dataRoot);
    this.loopCore = new OrchestratorLoopCore({
      enabled: options.enabled,
      intervalMs: options.intervalMs,
      onTick: async () => {
        await this.tickRecurring();
      },
      onError: (error) => {
        logger.error(
          `[workflow-recurring-dispatcher] tick failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  start(): void {
    this.loopCore.start();
  }

  stop(): void {
    this.loopCore.stop();
  }

  private buildSpawnRunId(): string {
    return `workflow-run-${randomUUID().slice(0, 12)}`;
  }

  private buildSpawnedRunInput(source: WorkflowRunRecord, mode: WorkflowRunMode) {
    const autoDispatchInitialRemaining = Math.max(
      0,
      Math.floor(source.autoDispatchInitialRemaining ?? source.autoDispatchRemaining ?? 5)
    );
    return {
      runId: this.buildSpawnRunId(),
      templateId: source.templateId,
      name: source.name,
      description: source.description,
      workspacePath: source.workspacePath,
      routeTable: cloneRouteMap(source.routeTable),
      taskAssignRouteTable: cloneRouteMap(source.taskAssignRouteTable),
      routeDiscussRounds: cloneDiscussRounds(source.routeDiscussRounds),
      variables: cloneStringMap(source.variables),
      taskOverrides: cloneStringMap(source.taskOverrides),
      tasks: cloneRunTasks(source.tasks),
      mode,
      loopEnabled: mode === "loop",
      scheduleEnabled: false,
      scheduleExpression: undefined,
      isScheduleSeed: false,
      originRunId: source.runId,
      autoDispatchEnabled: source.autoDispatchEnabled,
      autoDispatchRemaining: autoDispatchInitialRemaining,
      autoDispatchInitialRemaining,
      holdEnabled: source.holdEnabled,
      reminderMode: source.reminderMode
    };
  }

  private buildRecurringSourceLockPath(runId: string): string {
    return path.join(this.dataRoot, "workflows", RECURRING_SOURCE_LOCK_DIR, `${runId}.lock`);
  }

  private async withRecurringSourceLease<T>(
    runId: string,
    operation: (lease: RecurringSourceLease) => Promise<T | null>
  ): Promise<T | null> {
    const lease = await tryAcquireRecurringSourceLease(this.buildRecurringSourceLockPath(runId));
    if (!lease) {
      return null;
    }
    try {
      return await operation(lease);
    } finally {
      await releaseRecurringSourceLease(lease);
    }
  }

  private async startSpawnedRun(runId: string): Promise<boolean> {
    try {
      await this.workflowOrchestrator.startRun(runId);
      return true;
    } catch (error) {
      logger.error(
        `[workflow-recurring-dispatcher] failed to start spawned run '${runId}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return false;
    }
  }

  private async markSpawnedRunStartFailed(runId: string): Promise<void> {
    try {
      await this.repositories.workflowRuns.patchRun(runId, {
        status: "failed",
        stoppedAt: new Date().toISOString()
      });
    } catch (error) {
      logger.error(
        `[workflow-recurring-dispatcher] failed to mark spawned run '${runId}' as failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async createAndStartSpawnedRun(
    source: WorkflowRunRecord,
    mode: WorkflowRunMode,
    lease: RecurringSourceLease
  ): Promise<WorkflowRunRecord | null> {
    if (!(await isRecurringSourceLeaseActive(lease))) {
      return null;
    }
    const created = await this.repositories.workflowRuns.createRun(this.buildSpawnedRunInput(source, mode));
    if (!(await isRecurringSourceLeaseActive(lease))) {
      await this.markSpawnedRunStartFailed(created.runId);
      return null;
    }
    const started = await this.startSpawnedRun(created.runId);
    if (started) {
      if (!(await isRecurringSourceLeaseActive(lease))) {
        await this.markSpawnedRunStartFailed(created.runId);
        return null;
      }
      return created;
    }
    await this.markSpawnedRunStartFailed(created.runId);
    return null;
  }

  private async spawnLoopChild(parentRun: WorkflowRunRecord, nowIso: string): Promise<string | null> {
    return this.withRecurringSourceLease(parentRun.runId, async (lease) => {
      const refreshed = await this.repositories.workflowRuns.getRun(parentRun.runId);
      if (!refreshed) {
        return null;
      }
      const mode = resolveRecurringMode(refreshed);
      if (mode !== "loop" || !refreshed.loopEnabled || refreshed.status !== "finished" || refreshed.lastSpawnedRunId) {
        return null;
      }
      const created = await this.createAndStartSpawnedRun(refreshed, "loop", lease);
      if (!created) {
        return null;
      }
      if (!(await isRecurringSourceLeaseActive(lease))) {
        await this.markSpawnedRunStartFailed(created.runId);
        return null;
      }
      await this.repositories.workflowRuns.patchRun(refreshed.runId, {
        lastSpawnedRunId: created.runId,
        spawnState: {
          ...(refreshed.spawnState ?? {}),
          lastSpawnedRunId: created.runId,
          lastSpawnedAt: nowIso,
          lastTriggeredAt: nowIso
        }
      });
      return created.runId;
    });
  }

  private async resolveActiveSpawnedRunId(spawnState: WorkflowRunSpawnState): Promise<string | null> {
    if (!spawnState.activeRunId) {
      return null;
    }
    const activeRun = await this.repositories.workflowRuns.getRun(spawnState.activeRunId);
    if (!activeRun) {
      return null;
    }
    if (activeRun.status === "running" || activeRun.status === "created") {
      return activeRun.runId;
    }
    return null;
  }

  private async processScheduleSeed(seed: WorkflowRunRecord, now: Date, nowIso: string): Promise<string | null> {
    return this.withRecurringSourceLease(seed.runId, async (lease) => {
      const refreshed = await this.repositories.workflowRuns.getRun(seed.runId);
      if (!refreshed) {
        return null;
      }
      if (
        resolveRecurringMode(refreshed) !== "schedule" ||
        !refreshed.scheduleEnabled ||
        refreshed.isScheduleSeed === false
      ) {
        return null;
      }
      const parsed = parseWorkflowScheduleExpression(refreshed.scheduleExpression ?? undefined);
      if (!parsed) {
        return null;
      }
      const nextProbe = new Date(now.getTime());
      nextProbe.setMinutes(nextProbe.getMinutes() + 1);
      const spawnState = normalizeSpawnState(refreshed.spawnState);
      const activeRunId = await this.resolveActiveSpawnedRunId(spawnState);
      if (activeRunId) {
        spawnState.isActive = true;
        spawnState.activeRunId = activeRunId;
      } else {
        spawnState.isActive = false;
        spawnState.activeRunId = undefined;
      }
      spawnState.nextAvailableAt = computeNextWorkflowScheduleTriggerAt(parsed, nextProbe) ?? undefined;

      const matchedNow = matchesWorkflowSchedulePattern(parsed, now);
      const windowKey = matchedNow ? buildWorkflowScheduleWindowKey(parsed, now) : null;
      if (matchedNow && !spawnState.isActive && windowKey && spawnState.lastWindowKey !== windowKey) {
        const created = await this.createAndStartSpawnedRun(refreshed, "none", lease);
        if (created) {
          if (!(await isRecurringSourceLeaseActive(lease))) {
            await this.markSpawnedRunStartFailed(created.runId);
            return null;
          }
          const windowRange = resolveWorkflowScheduleWindowRange(parsed, now);
          spawnState.isActive = true;
          spawnState.activeRunId = created.runId;
          spawnState.lastWindowKey = windowKey;
          spawnState.lastSpawnedRunId = created.runId;
          spawnState.lastSpawnedAt = nowIso;
          spawnState.lastTriggeredAt = nowIso;
          spawnState.lastWindowStartAt = windowRange?.windowStartAt;
          spawnState.lastWindowEndAt = windowRange?.windowEndAt;
          await this.repositories.workflowRuns.patchRun(refreshed.runId, {
            lastSpawnedRunId: created.runId,
            spawnState
          });
          return created.runId;
        }
      }

      if (
        refreshed.lastSpawnedRunId !== spawnState.lastSpawnedRunId ||
        !isSpawnStateEqual(refreshed.spawnState, spawnState)
      ) {
        if (!(await isRecurringSourceLeaseActive(lease))) {
          return null;
        }
        await this.repositories.workflowRuns.patchRun(refreshed.runId, {
          lastSpawnedRunId: spawnState.lastSpawnedRunId ?? refreshed.lastSpawnedRunId,
          spawnState
        });
      }
      return null;
    });
  }

  async tickRecurring(now: Date = new Date()): Promise<void> {
    const nowIso = now.toISOString();
    const runs = await this.repositories.workflowRuns.listRuns();

    for (const run of runs) {
      try {
        const mode = resolveRecurringMode(run);
        if (mode !== "loop" || !run.loopEnabled || run.status !== "finished" || run.lastSpawnedRunId) {
          continue;
        }
        await this.spawnLoopChild(run, nowIso);
      } catch (error) {
        logger.error(
          `[workflow-recurring-dispatcher] loop recurring failed for run '${run.runId}': ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    for (const run of runs) {
      try {
        const mode = resolveRecurringMode(run);
        if (mode !== "schedule" || !run.scheduleEnabled || run.isScheduleSeed === false) {
          continue;
        }
        await this.processScheduleSeed(run, now, nowIso);
      } catch (error) {
        logger.error(
          `[workflow-recurring-dispatcher] schedule recurring failed for run '${run.runId}': ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
}

export function createWorkflowRecurringDispatcherService(
  dataRoot: string,
  workflowOrchestrator: WorkflowOrchestratorService
): WorkflowRecurringDispatcherService {
  return new WorkflowRecurringDispatcherService(
    dataRoot,
    workflowOrchestrator,
    resolveWorkflowRecurringDispatcherOptionsFromEnv()
  );
}
