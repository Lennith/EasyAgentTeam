import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createMemoryProjectFixture } from "./helpers/project-orchestrator-fixtures.js";
import {
  ProjectSessionRuntimeService,
  terminateProcessByPid
} from "../services/orchestrator/project/project-session-runtime-service.js";

test("project session runtime service terminates a live child process by pid", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore",
    windowsHide: true
  });
  assert.ok(child.pid);
  const result = await terminateProcessByPid(child.pid!);
  assert.equal(result.attempted, true);
  assert.equal(result.result === "killed" || result.result === "not_found", true);
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
});

test("project session runtime service returns skipped_no_pid when session has no pid or open run", async () => {
  const fixture = createMemoryProjectFixture("session-runtime");
  try {
    const created = await fixture.createProject("session-runtime-project");
    await fixture.repositories.sessions.addSession(created.paths, created.project.projectId, {
      sessionId: "session-dev",
      role: "dev",
      status: "idle"
    });
    const service = new ProjectSessionRuntimeService({
      dataRoot: fixture.dataRoot,
      providerRegistry: {} as any,
      repositories: fixture.repositories,
      sessionRunningTimeoutMs: 60_000,
      clearInFlightDispatchSession: () => {}
    });

    const result = await service.terminateSessionProcess(created.project.projectId, "session-dev", "manual_test");
    assert.equal(result.result, "skipped_no_pid");
    assert.equal(result.attempted, false);
  } finally {
    fixture.cleanup();
  }
});

test("project session runtime service repairs session status and appends repair event", async () => {
  const fixture = createMemoryProjectFixture("session-repair");
  try {
    const created = await fixture.createProject("session-repair-project");
    await fixture.repositories.sessions.addSession(created.paths, created.project.projectId, {
      sessionId: "session-dev",
      role: "dev",
      status: "dismissed"
    });
    const service = new ProjectSessionRuntimeService({
      dataRoot: fixture.dataRoot,
      providerRegistry: {} as any,
      repositories: fixture.repositories,
      sessionRunningTimeoutMs: 60_000,
      clearInFlightDispatchSession: () => {}
    });

    const repaired = await service.repairSessionStatus(
      created.project.projectId,
      "session-dev",
      "idle",
      "manual_test_repair"
    );
    const events = await fixture.repositories.events.listEvents(created.paths);

    assert.equal(repaired.session.status, "idle");
    assert.equal(repaired.action, "repair");
    assert.equal(
      events.some((event) => event.eventType === "SESSION_STATUS_REPAIRED"),
      true
    );
  } finally {
    fixture.cleanup();
  }
});
