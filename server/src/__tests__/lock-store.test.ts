import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import {
  acquireLock,
  createProjectLockScope,
  listActiveLocks,
  releaseLock,
  renewLock
} from "../data/repository/project/lock-repository.js";
import { createProject } from "../data/repository/project/runtime-repository.js";

test("lock acquire conflict then steal after expiry", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step2-lock-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "locktest",
    name: "Lock Test",
    workspacePath: tempRoot
  });
  const scope = createProjectLockScope(dataRoot, created.project.projectId, created.project.workspacePath);

  const first = await acquireLock(scope, {
    sessionId: "session-a",
    lockKey: "src/server",
    ttlSeconds: 1,
    purpose: "edit server files"
  });
  assert.equal(first.kind, "acquired");

  const second = await acquireLock(scope, {
    sessionId: "session-b",
    lockKey: "src/server",
    ttlSeconds: 1
  });
  assert.equal(second.kind, "failed");

  await delay(1200);

  const stolen = await acquireLock(scope, {
    sessionId: "session-b",
    lockKey: "src/server",
    ttlSeconds: 30
  });
  assert.equal(stolen.kind, "stolen");

  const active = await listActiveLocks(scope);
  assert.equal(active.length, 1);
  assert.equal(active[0].ownerSessionId, "session-b");
  assert.equal(active[0].lockKey, "src/server");
  assert.equal(active[0].ownerDomain, "project");
  assert.equal(active[0].ownerDomainId, created.project.projectId);
});

test("lock renew and release require owner domain + id + session", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step2-renew-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "renewtest",
    name: "Renew Test",
    workspacePath: tempRoot
  });
  const scope = createProjectLockScope(dataRoot, created.project.projectId, created.project.workspacePath);
  const foreignScope = createProjectLockScope(dataRoot, "other-project", created.project.workspacePath);

  const acquired = await acquireLock(scope, {
    sessionId: "session-owner",
    lockKey: "docs/10_design",
    ttlSeconds: 30
  });
  assert.equal(acquired.kind, "acquired");

  const renewed = await renewLock(scope, {
    sessionId: "session-owner",
    lockKey: "docs/10_design"
  });
  assert.equal(renewed.kind, "renewed");
  if (renewed.kind === "renewed") {
    assert.equal(renewed.lock.renewCount, 1);
  }

  const wrongScopeRenew = await renewLock(foreignScope, {
    sessionId: "session-owner",
    lockKey: "docs/10_design"
  });
  assert.equal(wrongScopeRenew.kind, "not_owner");

  const wrongScopeRelease = await releaseLock(foreignScope, {
    sessionId: "session-owner",
    lockKey: "docs/10_design"
  });
  assert.equal(wrongScopeRelease.kind, "not_owner");

  const released = await releaseLock(scope, {
    sessionId: "session-owner",
    lockKey: "docs/10_design"
  });
  assert.equal(released.kind, "released");

  const active = await listActiveLocks(scope);
  assert.equal(active.length, 0);
});

test("file lock blocks acquiring ancestor dir lock", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-lock-hierarchy-file-dir-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "hierarchyfiledir",
    name: "Hierarchy File Dir",
    workspacePath: tempRoot
  });
  const scope = createProjectLockScope(dataRoot, created.project.projectId, created.project.workspacePath);

  const fileLock = await acquireLock(scope, {
    sessionId: "session-file",
    lockKey: "dirA/dirB/fileA.txt",
    targetType: "file",
    ttlSeconds: 60
  });
  assert.equal(fileLock.kind, "acquired");

  const dirLock = await acquireLock(scope, {
    sessionId: "session-dir",
    lockKey: "dirA",
    targetType: "dir",
    ttlSeconds: 60
  });
  assert.equal(dirLock.kind, "failed");
});

test("dir lock blocks acquiring descendant file lock", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-lock-hierarchy-dir-file-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "hierarchydirfile",
    name: "Hierarchy Dir File",
    workspacePath: tempRoot
  });
  const scope = createProjectLockScope(dataRoot, created.project.projectId, created.project.workspacePath);

  const dirLock = await acquireLock(scope, {
    sessionId: "session-dir",
    lockKey: "dirA",
    targetType: "dir",
    ttlSeconds: 60
  });
  assert.equal(dirLock.kind, "acquired");

  const fileLock = await acquireLock(scope, {
    sessionId: "session-file",
    lockKey: "dirA/dirB/fileA.txt",
    targetType: "file",
    ttlSeconds: 60
  });
  assert.equal(fileLock.kind, "failed");
});

test("sibling file locks do not conflict", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-lock-sibling-files-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "siblinglocks",
    name: "Sibling Locks",
    workspacePath: tempRoot
  });
  const scope = createProjectLockScope(dataRoot, created.project.projectId, created.project.workspacePath);

  const first = await acquireLock(scope, {
    sessionId: "session-a",
    lockKey: "src/a.ts",
    ttlSeconds: 60
  });
  assert.equal(first.kind, "acquired");

  const second = await acquireLock(scope, {
    sessionId: "session-b",
    lockKey: "src/b.ts",
    ttlSeconds: 60
  });
  assert.equal(second.kind, "acquired");
});

test("default target_type behaves as file and does not block child path", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-lock-default-file-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "defaulttarget",
    name: "Default Target",
    workspacePath: tempRoot
  });
  const scope = createProjectLockScope(dataRoot, created.project.projectId, created.project.workspacePath);

  const fileLike = await acquireLock(scope, {
    sessionId: "session-a",
    lockKey: "docs/spec",
    ttlSeconds: 60
  });
  assert.equal(fileLike.kind, "acquired");

  const childPath = await acquireLock(scope, {
    sessionId: "session-b",
    lockKey: "docs/spec/chapter-1.md",
    ttlSeconds: 60
  });
  assert.equal(childPath.kind, "acquired");
});
