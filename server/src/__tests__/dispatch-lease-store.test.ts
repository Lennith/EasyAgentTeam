import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { createRepository } from "../data/repository/shared/runtime.js";
import {
  closeDispatchLease,
  findBlockingDispatchLease,
  heartbeatDispatchLease,
  readDispatchLeaseIndex,
  reconcileDispatchLeasesFromEvents,
  recoverExpiredDispatchLeases,
  upsertDispatchLease
} from "../services/orchestrator/shared/dispatch-lease-store.js";

test("dispatch lease blocks, heartbeats, expires, recovers, and closes", async () => {
  const repository = createRepository("file");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-dispatch-lease-"));
  const leaseFile = path.join(tempRoot, "dispatch-leases.json");
  const now = new Date("2026-05-05T00:00:00.000Z");

  await upsertDispatchLease(
    repository,
    leaseFile,
    {
      dispatchId: "dispatch-1",
      scopeKind: "workflow",
      scopeId: "run-1",
      sessionId: "session-1",
      role: "developer",
      dispatchKind: "task",
      taskId: "task-1",
      messageId: "message-1"
    },
    { now, ttlMs: 1_000 }
  );

  assert.equal(
    (
      await findBlockingDispatchLease(repository, leaseFile, {
        scopeKind: "workflow",
        scopeId: "run-1",
        sessionId: "session-1",
        taskId: "task-other",
        now: new Date("2026-05-05T00:00:00.500Z")
      })
    )?.dispatch_id,
    "dispatch-1"
  );

  await heartbeatDispatchLease(repository, leaseFile, "dispatch-1", {
    now: new Date("2026-05-05T00:00:00.800Z"),
    ttlMs: 1_000
  });
  assert.equal(
    (
      await findBlockingDispatchLease(repository, leaseFile, {
        scopeKind: "workflow",
        scopeId: "run-1",
        sessionId: "session-1",
        taskId: "task-1",
        now: new Date("2026-05-05T00:00:01.500Z")
      })
    )?.dispatch_id,
    "dispatch-1"
  );

  const recovered = await recoverExpiredDispatchLeases(repository, leaseFile, {
    now: new Date("2026-05-05T00:00:02.000Z"),
    createRecoveryAttemptId: () => "recovery-1"
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.status, "cooldown");
  assert.equal(recovered[0]?.recovery_attempt_id, "recovery-1");
  assert.equal(
    await findBlockingDispatchLease(repository, leaseFile, {
      scopeKind: "workflow",
      scopeId: "run-1",
      sessionId: "session-1",
      taskId: "task-1",
      now: new Date("2026-05-05T00:00:02.000Z")
    }),
    null
  );

  await closeDispatchLease(repository, leaseFile, "dispatch-1", { now: new Date("2026-05-05T00:00:03.000Z") });
  const index = await readDispatchLeaseIndex(repository, leaseFile);
  assert.equal(index.leases[0]?.status, "closed");
});

test("dispatch lease index can be rebuilt from open dispatch events without replacing recovery_attempt_id", async () => {
  const repository = createRepository("file");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-dispatch-lease-events-"));
  const leaseFile = path.join(tempRoot, "dispatch-leases.json");

  await reconcileDispatchLeasesFromEvents(repository, leaseFile, {
    scopeKind: "project",
    scopeId: "project-1",
    now: new Date("2026-05-05T00:00:00.000Z"),
    events: [
      {
        eventType: "ORCHESTRATOR_DISPATCH_STARTED",
        createdAt: "2026-05-05T00:00:00.000Z",
        sessionId: "session-1",
        taskId: "task-1",
        payload: {
          dispatchId: "dispatch-1",
          dispatchKind: "task",
          messageId: "message-1",
          recovery_attempt_id: "recovery-existing"
        }
      }
    ]
  });

  let index = await readDispatchLeaseIndex(repository, leaseFile);
  assert.equal(index.leases.length, 1);
  assert.equal(index.leases[0]?.dispatch_id, "dispatch-1");
  assert.equal(index.leases[0]?.recovery_attempt_id, "recovery-existing");

  await reconcileDispatchLeasesFromEvents(repository, leaseFile, {
    scopeKind: "project",
    scopeId: "project-1",
    now: new Date("2026-05-05T00:01:00.000Z"),
    events: [
      {
        eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
        createdAt: "2026-05-05T00:01:00.000Z",
        sessionId: "session-1",
        taskId: "task-1",
        payload: {
          dispatchId: "dispatch-1"
        }
      }
    ]
  });

  index = await readDispatchLeaseIndex(repository, leaseFile);
  assert.equal(index.leases[0]?.status, "closed");
  assert.equal(index.leases[0]?.recovery_attempt_id, "recovery-existing");
});
