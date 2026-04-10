import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import {
  createWorkflowRun,
  createWorkflowTemplate,
  listWorkflowRuns,
  patchWorkflowRun
} from "../data/repository/workflow/run-repository.js";
import { WorkflowRecurringDispatcherService } from "../services/orchestrator/workflow/workflow-recurring-dispatcher.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("workflow recurring dispatcher spawns loop run from finished parent", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-recurring-loop-"));
  const startedRunIds: string[] = [];
  const workflowOrchestratorStub = {
    startRun: async (runId: string) => {
      startedRunIds.push(runId);
      return { runId, status: "running", active: true };
    }
  } as any;

  await createWorkflowTemplate(tempRoot, {
    templateId: "loop_tpl",
    name: "Loop Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(tempRoot, {
    runId: "loop_seed_run",
    templateId: "loop_tpl",
    name: "Loop Seed",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }],
    mode: "loop",
    loopEnabled: true,
    scheduleEnabled: false,
    autoDispatchRemaining: 1,
    autoDispatchInitialRemaining: 3
  });
  await patchWorkflowRun(tempRoot, "loop_seed_run", { status: "finished" });

  const dispatcher = new WorkflowRecurringDispatcherService(tempRoot, workflowOrchestratorStub, {
    enabled: true,
    intervalMs: 60000
  });
  await dispatcher.tickRecurring(new Date("2026-04-08T01:00:00.000Z"));

  const runs = await listWorkflowRuns(tempRoot);
  assert.equal(runs.length, 2);
  const parent = runs.find((item) => item.runId === "loop_seed_run");
  assert.ok(parent?.lastSpawnedRunId);
  const child = runs.find((item) => item.runId === parent?.lastSpawnedRunId);
  assert.ok(child);
  assert.equal(child.originRunId, "loop_seed_run");
  assert.equal(child.mode, "loop");
  assert.equal(child.loopEnabled, true);
  assert.equal(child.autoDispatchInitialRemaining, 3);
  assert.equal(child.autoDispatchRemaining, 3);
  assert.equal(startedRunIds[0], child.runId);
});

test("workflow recurring dispatcher does not duplicate loop spawn across overlapping ticks", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-recurring-loop-lock-"));
  const startedRunIds: string[] = [];
  const firstStartEntered = createDeferred<void>();
  const releaseFirstStart = createDeferred<void>();
  let startCalls = 0;
  const workflowOrchestratorStub = {
    startRun: async (runId: string) => {
      startedRunIds.push(runId);
      startCalls += 1;
      if (startCalls === 1) {
        firstStartEntered.resolve();
        await releaseFirstStart.promise;
      }
      return { runId, status: "running", active: true };
    }
  } as any;

  await createWorkflowTemplate(tempRoot, {
    templateId: "loop_tpl",
    name: "Loop Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(tempRoot, {
    runId: "loop_seed_run",
    templateId: "loop_tpl",
    name: "Loop Seed",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }],
    mode: "loop",
    loopEnabled: true,
    scheduleEnabled: false
  });
  await patchWorkflowRun(tempRoot, "loop_seed_run", { status: "finished" });

  const dispatcher = new WorkflowRecurringDispatcherService(tempRoot, workflowOrchestratorStub, {
    enabled: true,
    intervalMs: 60000
  });
  const firstTick = dispatcher.tickRecurring(new Date("2026-04-08T01:00:00.000Z"));
  await firstStartEntered.promise;
  const secondTick = dispatcher.tickRecurring(new Date("2026-04-08T01:00:00.000Z"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirstStart.resolve();
  await Promise.all([firstTick, secondTick]);

  const runs = await listWorkflowRuns(tempRoot);
  assert.equal(runs.length, 2);
  const parent = runs.find((item) => item.runId === "loop_seed_run");
  assert.ok(parent?.lastSpawnedRunId);
  assert.equal(startedRunIds.length, 1);
});

test("workflow recurring dispatcher does not duplicate schedule spawn across overlapping ticks", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-recurring-schedule-lock-"));
  const startedRunIds: string[] = [];
  const firstStartEntered = createDeferred<void>();
  const releaseFirstStart = createDeferred<void>();
  let startCalls = 0;
  const workflowOrchestratorStub = {
    startRun: async (runId: string) => {
      startedRunIds.push(runId);
      startCalls += 1;
      if (startCalls === 1) {
        firstStartEntered.resolve();
        await releaseFirstStart.promise;
      }
      return { runId, status: "running", active: true };
    }
  } as any;

  await createWorkflowTemplate(tempRoot, {
    templateId: "schedule_tpl",
    name: "Schedule Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(tempRoot, {
    runId: "schedule_seed_run",
    templateId: "schedule_tpl",
    name: "Schedule Seed",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }],
    mode: "schedule",
    loopEnabled: false,
    scheduleEnabled: true,
    scheduleExpression: "XX-XX 09:XX",
    isScheduleSeed: true
  });

  const dispatcher = new WorkflowRecurringDispatcherService(tempRoot, workflowOrchestratorStub, {
    enabled: true,
    intervalMs: 60000
  });
  const firstTick = dispatcher.tickRecurring(new Date("2026-04-08T01:00:00.000Z"));
  await firstStartEntered.promise;
  const secondTick = dispatcher.tickRecurring(new Date("2026-04-08T01:00:00.000Z"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseFirstStart.resolve();
  await Promise.all([firstTick, secondTick]);

  const runs = await listWorkflowRuns(tempRoot);
  assert.equal(runs.length, 2);
  const seed = runs.find((item) => item.runId === "schedule_seed_run");
  assert.ok(seed?.lastSpawnedRunId);
  assert.equal(seed?.spawnState?.activeRunId, seed?.lastSpawnedRunId);
  assert.equal(startedRunIds.length, 1);
});

test("workflow recurring dispatcher starts loop child even if another recurring seed fails later in tick", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-recurring-loop-isolation-"));
  const startedRunIds: string[] = [];
  const workflowOrchestratorStub = {
    startRun: async (runId: string) => {
      startedRunIds.push(runId);
      return { runId, status: "running", active: true };
    }
  } as any;

  await createWorkflowTemplate(tempRoot, {
    templateId: "loop_tpl",
    name: "Loop Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowTemplate(tempRoot, {
    templateId: "schedule_tpl",
    name: "Schedule Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(tempRoot, {
    runId: "loop_seed_run",
    templateId: "loop_tpl",
    name: "Loop Seed",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }],
    mode: "loop",
    loopEnabled: true,
    scheduleEnabled: false,
    autoDispatchRemaining: 1,
    autoDispatchInitialRemaining: 3
  });
  await patchWorkflowRun(tempRoot, "loop_seed_run", { status: "finished" });
  await createWorkflowRun(tempRoot, {
    runId: "schedule_seed_run",
    templateId: "schedule_tpl",
    name: "Schedule Seed",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }],
    mode: "schedule",
    loopEnabled: false,
    scheduleEnabled: true,
    scheduleExpression: "XX-XX 09:XX",
    isScheduleSeed: true
  });

  const dispatcher = new WorkflowRecurringDispatcherService(tempRoot, workflowOrchestratorStub, {
    enabled: true,
    intervalMs: 60000
  });
  const originalProcessScheduleSeed = (dispatcher as any).processScheduleSeed.bind(dispatcher);
  (dispatcher as any).processScheduleSeed = async (seed: { runId: string }, now: Date, nowIso: string) => {
    if (seed.runId === "schedule_seed_run") {
      throw new Error("schedule seed failure");
    }
    return originalProcessScheduleSeed(seed, now, nowIso);
  };

  await dispatcher.tickRecurring(new Date("2026-04-08T01:00:00.000Z"));

  const runs = await listWorkflowRuns(tempRoot);
  const parent = runs.find((item) => item.runId === "loop_seed_run");
  const child = runs.find((item) => item.runId === parent?.lastSpawnedRunId);
  assert.ok(child);
  assert.equal(startedRunIds[0], child.runId);
});

test("workflow recurring dispatcher retries loop spawn after child start failure", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-recurring-loop-retry-"));
  const startedRunIds: string[] = [];
  let shouldFailStart = true;
  const workflowOrchestratorStub = {
    startRun: async (runId: string) => {
      if (shouldFailStart) {
        shouldFailStart = false;
        throw new Error("start failed once");
      }
      startedRunIds.push(runId);
      return { runId, status: "running", active: true };
    }
  } as any;

  await createWorkflowTemplate(tempRoot, {
    templateId: "loop_tpl",
    name: "Loop Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(tempRoot, {
    runId: "loop_seed_run",
    templateId: "loop_tpl",
    name: "Loop Seed",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }],
    mode: "loop",
    loopEnabled: true,
    scheduleEnabled: false
  });
  await patchWorkflowRun(tempRoot, "loop_seed_run", { status: "finished" });

  const dispatcher = new WorkflowRecurringDispatcherService(tempRoot, workflowOrchestratorStub, {
    enabled: true,
    intervalMs: 60000
  });

  await dispatcher.tickRecurring(new Date("2026-04-08T01:00:00.000Z"));
  const runsAfterFailure = await listWorkflowRuns(tempRoot);
  const parentAfterFailure = runsAfterFailure.find((item) => item.runId === "loop_seed_run");
  const failedChild = runsAfterFailure.find((item) => item.runId !== "loop_seed_run");
  assert.equal(parentAfterFailure?.lastSpawnedRunId, undefined);
  assert.ok(failedChild);
  assert.equal(failedChild.status, "failed");

  await dispatcher.tickRecurring(new Date("2026-04-08T01:01:00.000Z"));
  const runsAfterRetry = await listWorkflowRuns(tempRoot);
  const parentAfterRetry = runsAfterRetry.find((item) => item.runId === "loop_seed_run");
  assert.ok(parentAfterRetry?.lastSpawnedRunId);
  assert.notEqual(parentAfterRetry?.lastSpawnedRunId, failedChild.runId);
  assert.equal(startedRunIds.length, 1);
});

test("workflow recurring dispatcher enforces schedule single-active and HH:XX next-minute retry", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-recurring-schedule-"));
  const startedRunIds: string[] = [];
  const workflowOrchestratorStub = {
    startRun: async (runId: string) => {
      startedRunIds.push(runId);
      return { runId, status: "running", active: true };
    }
  } as any;

  await createWorkflowTemplate(tempRoot, {
    templateId: "schedule_tpl",
    name: "Schedule Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(tempRoot, {
    runId: "schedule_seed_run",
    templateId: "schedule_tpl",
    name: "Schedule Seed",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }],
    mode: "schedule",
    loopEnabled: false,
    scheduleEnabled: true,
    scheduleExpression: "XX-XX 09:XX",
    isScheduleSeed: true,
    autoDispatchRemaining: 1,
    autoDispatchInitialRemaining: 4
  });

  const dispatcher = new WorkflowRecurringDispatcherService(tempRoot, workflowOrchestratorStub, {
    enabled: true,
    intervalMs: 60000
  });

  await dispatcher.tickRecurring(new Date("2026-04-08T01:00:00.000Z"));
  const afterFirstTick = await listWorkflowRuns(tempRoot);
  const seedAfterFirst = afterFirstTick.find((item) => item.runId === "schedule_seed_run");
  assert.ok(seedAfterFirst?.lastSpawnedRunId);
  const firstChildId = seedAfterFirst?.lastSpawnedRunId as string;
  const firstChild = afterFirstTick.find((item) => item.runId === firstChildId);
  assert.ok(firstChild);
  assert.equal(firstChild.mode, "none");
  assert.equal(firstChild.scheduleEnabled, false);
  assert.equal(firstChild.isScheduleSeed, false);
  assert.equal(firstChild.autoDispatchInitialRemaining, 4);
  assert.equal(firstChild.autoDispatchRemaining, 4);
  assert.equal(startedRunIds.length, 1);

  await dispatcher.tickRecurring(new Date("2026-04-08T01:01:00.000Z"));
  const afterSecondTick = await listWorkflowRuns(tempRoot);
  assert.equal(afterSecondTick.length, 2, "active child should block new spawn");

  await patchWorkflowRun(tempRoot, firstChildId, { status: "finished" });
  await dispatcher.tickRecurring(new Date("2026-04-08T01:02:00.000Z"));
  const afterThirdTick = await listWorkflowRuns(tempRoot);
  const seedAfterThird = afterThirdTick.find((item) => item.runId === "schedule_seed_run");
  assert.ok(seedAfterThird?.lastSpawnedRunId);
  assert.notEqual(seedAfterThird?.lastSpawnedRunId, firstChildId);
  assert.equal(afterThirdTick.length, 3, "finished child should allow next-minute spawn in same hour window");
  assert.equal(startedRunIds.length, 2);
});

test("workflow recurring dispatcher retries schedule spawn after child start failure without consuming the window", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-workflow-recurring-schedule-retry-"));
  const startedRunIds: string[] = [];
  let shouldFailStart = true;
  const workflowOrchestratorStub = {
    startRun: async (runId: string) => {
      if (shouldFailStart) {
        shouldFailStart = false;
        throw new Error("schedule start failed once");
      }
      startedRunIds.push(runId);
      return { runId, status: "running", active: true };
    }
  } as any;

  await createWorkflowTemplate(tempRoot, {
    templateId: "schedule_tpl",
    name: "Schedule Template",
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead" }]
  });
  await createWorkflowRun(tempRoot, {
    runId: "schedule_seed_run",
    templateId: "schedule_tpl",
    name: "Schedule Seed",
    workspacePath: tempRoot,
    tasks: [{ taskId: "task_a", title: "Task A", ownerRole: "lead", resolvedTitle: "Task A" }],
    mode: "schedule",
    loopEnabled: false,
    scheduleEnabled: true,
    scheduleExpression: "XX-XX 09:XX",
    isScheduleSeed: true
  });

  const dispatcher = new WorkflowRecurringDispatcherService(tempRoot, workflowOrchestratorStub, {
    enabled: true,
    intervalMs: 60000
  });

  await dispatcher.tickRecurring(new Date("2026-04-08T01:00:00.000Z"));
  const runsAfterFailure = await listWorkflowRuns(tempRoot);
  const seedAfterFailure = runsAfterFailure.find((item) => item.runId === "schedule_seed_run");
  const failedChild = runsAfterFailure.find((item) => item.runId !== "schedule_seed_run");
  assert.equal(seedAfterFailure?.lastSpawnedRunId, undefined);
  assert.equal(seedAfterFailure?.spawnState?.lastWindowKey, undefined);
  assert.ok(failedChild);
  assert.equal(failedChild.status, "failed");

  await dispatcher.tickRecurring(new Date("2026-04-08T01:01:00.000Z"));
  const runsAfterRetry = await listWorkflowRuns(tempRoot);
  const seedAfterRetry = runsAfterRetry.find((item) => item.runId === "schedule_seed_run");
  assert.ok(seedAfterRetry?.lastSpawnedRunId);
  assert.notEqual(seedAfterRetry?.lastSpawnedRunId, failedChild.runId);
  assert.equal(seedAfterRetry?.spawnState?.activeRunId, seedAfterRetry?.lastSpawnedRunId);
  assert.equal(startedRunIds.length, 1);
});
