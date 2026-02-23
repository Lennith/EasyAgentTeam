import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  acquireLock,
  listActiveLocks,
  releaseLock,
  renewLock
} from "../data/lock-store.js";
import { createProject } from "../data/project-store.js";

test("lock acquire conflict then steal after expiry", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step2-lock-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "locktest",
    name: "Lock Test",
    workspacePath: tempRoot
  });

  const first = await acquireLock(created.paths, {
    projectId: "locktest",
    sessionId: "session-a",
    lockKey: "src/server",
    ttlSeconds: 1,
    purpose: "edit server files"
  });
  assert.equal(first.kind, "acquired");

  const second = await acquireLock(created.paths, {
    projectId: "locktest",
    sessionId: "session-b",
    lockKey: "src/server",
    ttlSeconds: 1
  });
  assert.equal(second.kind, "failed");

  await delay(1200);

  const stolen = await acquireLock(created.paths, {
    projectId: "locktest",
    sessionId: "session-b",
    lockKey: "src/server",
    ttlSeconds: 30
  });
  assert.equal(stolen.kind, "stolen");

  const active = await listActiveLocks(created.paths);
  assert.equal(active.length, 1);
  assert.equal(active[0].ownerSessionId, "session-b");
  assert.equal(active[0].lockKey, "src/server");
});

test("lock renew and release require owner session", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step2-renew-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "renewtest",
    name: "Renew Test",
    workspacePath: tempRoot
  });

  const acquired = await acquireLock(created.paths, {
    projectId: "renewtest",
    sessionId: "session-owner",
    lockKey: "docs/10_design",
    ttlSeconds: 30
  });
  assert.equal(acquired.kind, "acquired");

  const renewed = await renewLock(created.paths, {
    sessionId: "session-owner",
    lockKey: "docs/10_design"
  });
  assert.equal(renewed.kind, "renewed");
  if (renewed.kind === "renewed") {
    assert.equal(renewed.lock.renewCount, 1);
  }

  const wrongRenew = await renewLock(created.paths, {
    sessionId: "session-other",
    lockKey: "docs/10_design"
  });
  assert.equal(wrongRenew.kind, "not_owner");

  const wrongRelease = await releaseLock(created.paths, {
    sessionId: "session-other",
    lockKey: "docs/10_design"
  });
  assert.equal(wrongRelease.kind, "not_owner");

  const released = await releaseLock(created.paths, {
    sessionId: "session-owner",
    lockKey: "docs/10_design"
  });
  assert.equal(released.kind, "released");

  const active = await listActiveLocks(created.paths);
  assert.equal(active.length, 0);
});

