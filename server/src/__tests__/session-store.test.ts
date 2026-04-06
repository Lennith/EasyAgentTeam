import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createProject } from "../data/repository/project/runtime-repository.js";
import { addSession, resolveLatestSessionByRole, touchSession } from "../data/repository/project/session-repository.js";

test("resolve latest session by role uses lastActiveAt", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step45-session-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "sessiontest",
    name: "Session Test",
    workspacePath: tempRoot
  });

  await addSession(created.paths, "sessiontest", {
    sessionId: "sess-dev-a",
    role: "dev_backend"
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await addSession(created.paths, "sessiontest", {
    sessionId: "sess-dev-b",
    role: "dev_backend"
  });

  const latestBeforeTouch = await resolveLatestSessionByRole(created.paths, "sessiontest", "dev_backend");
  assert.equal(latestBeforeTouch?.sessionId, "sess-dev-b");

  await touchSession(created.paths, "sessiontest", "sess-dev-a", { status: "running" });
  const latestAfterTouch = await resolveLatestSessionByRole(created.paths, "sessiontest", "dev_backend");
  assert.equal(latestAfterTouch?.sessionId, "sess-dev-a");
});

test("session pid is cleared when status is not running", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-step45-session-pid-"));
  const dataRoot = path.join(tempRoot, "data");
  const created = await createProject(dataRoot, {
    projectId: "sessionpidtest",
    name: "Session PID Test",
    workspacePath: tempRoot
  });

  await addSession(created.paths, "sessionpidtest", {
    sessionId: "sess-dev-a",
    role: "dev_backend",
    status: "running"
  });
  const running = await touchSession(created.paths, "sessionpidtest", "sess-dev-a", {
    status: "running",
    agentPid: 43210
  });
  assert.equal(running.agentPid, 43210);

  const idle = await touchSession(created.paths, "sessionpidtest", "sess-dev-a", {
    status: "idle"
  });
  assert.equal(idle.agentPid, undefined);
});
