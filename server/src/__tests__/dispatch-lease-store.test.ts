import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { createRepository } from "../data/repository/shared/runtime.js";
import {
  closeDispatchLease,
  countActiveDispatchLeases,
  findBlockingDispatchLease,
  heartbeatDispatchLease,
  readDispatchLeaseIndex,
  reconcileDispatchLeasesFromEvents,
  recoverExpiredDispatchLeases,
  reserveDispatchLease,
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

test("dispatch lease active count ignores expired and closed leases", async () => {
  const repository = createRepository("file");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-dispatch-lease-count-"));
  const leaseFile = path.join(tempRoot, "dispatch-leases.json");
  const now = new Date("2026-05-05T00:00:00.000Z");

  await upsertDispatchLease(
    repository,
    leaseFile,
    {
      dispatchId: "open-1",
      scopeKind: "workflow",
      scopeId: "run-1",
      sessionId: "session-1",
      role: "lead",
      dispatchKind: "task"
    },
    { now, ttlMs: 10_000 }
  );
  await upsertDispatchLease(
    repository,
    leaseFile,
    {
      dispatchId: "closed-1",
      scopeKind: "workflow",
      scopeId: "run-1",
      sessionId: "session-2",
      role: "qa",
      dispatchKind: "task"
    },
    { now, ttlMs: 10_000 }
  );
  await closeDispatchLease(repository, leaseFile, "closed-1", { now });
  await upsertDispatchLease(
    repository,
    leaseFile,
    {
      dispatchId: "expired-1",
      scopeKind: "workflow",
      scopeId: "run-1",
      sessionId: "session-3",
      role: "ux",
      dispatchKind: "task"
    },
    { now, ttlMs: 1 }
  );

  const count = await countActiveDispatchLeases(repository, leaseFile, {
    scopeKind: "workflow",
    scopeId: "run-1",
    now: new Date("2026-05-05T00:00:01.000Z")
  });

  assert.equal(count, 1);
});

test("dispatch lease concurrent read-modify-write preserves all records", async () => {
  const repository = createRepository("file");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-dispatch-lease-concurrent-"));
  const leaseFile = path.join(tempRoot, "dispatch-leases.json");
  const now = new Date("2026-05-05T00:00:00.000Z");

  await Promise.all(
    Array.from({ length: 12 }, async (_item, index) =>
      upsertDispatchLease(
        repository,
        leaseFile,
        {
          dispatchId: `dispatch-${index}`,
          scopeKind: "project",
          scopeId: "project-1",
          sessionId: `session-${index}`,
          role: `role-${index}`,
          dispatchKind: "task"
        },
        { now, ttlMs: 10_000 }
      )
    )
  );

  const index = await readDispatchLeaseIndex(repository, leaseFile);
  assert.equal(index.leases.length, 12);
  assert.deepEqual(
    new Set(index.leases.map((lease) => lease.dispatch_id)),
    new Set(Array.from({ length: 12 }, (_item, index) => `dispatch-${index}`))
  );
});

test("dispatch lease reservation atomically enforces active concurrency cap", async () => {
  const repository = createRepository("file");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-dispatch-lease-reserve-"));
  const leaseFile = path.join(tempRoot, "dispatch-leases.json");
  const now = new Date("2026-05-05T00:00:00.000Z");

  const results = await Promise.all(
    Array.from({ length: 8 }, async (_item, index) =>
      reserveDispatchLease(
        repository,
        leaseFile,
        {
          dispatchId: `reserve-${index}`,
          scopeKind: "project",
          scopeId: "project-1",
          sessionId: `session-${index}`,
          role: `role-${index}`,
          dispatchKind: "task"
        },
        { maxActive: 2, now, ttlMs: 10_000 }
      )
    )
  );

  assert.equal(results.filter((item) => item.reserved).length, 2);
  assert.equal(results.filter((item) => !item.reserved).length, 6);
  assert.equal(
    await countActiveDispatchLeases(repository, leaseFile, {
      scopeKind: "project",
      scopeId: "project-1",
      now
    }),
    2
  );
});

test("dispatch lease reservation ignores expired active rows", async () => {
  const repository = createRepository("file");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-dispatch-lease-reserve-expired-"));
  const leaseFile = path.join(tempRoot, "dispatch-leases.json");
  const now = new Date("2026-05-05T00:00:00.000Z");

  await upsertDispatchLease(
    repository,
    leaseFile,
    {
      dispatchId: "expired",
      scopeKind: "workflow",
      scopeId: "run-1",
      sessionId: "session-old",
      role: "lead",
      dispatchKind: "task"
    },
    { now, ttlMs: 1 }
  );

  const reserved = await reserveDispatchLease(
    repository,
    leaseFile,
    {
      dispatchId: "fresh",
      scopeKind: "workflow",
      scopeId: "run-1",
      sessionId: "session-new",
      role: "qa",
      dispatchKind: "task"
    },
    { maxActive: 1, now: new Date("2026-05-05T00:00:01.000Z"), ttlMs: 10_000 }
  );

  assert.equal(reserved.reserved, true);
  assert.equal(reserved.lease?.dispatch_id, "fresh");
});
