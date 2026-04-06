import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import test from "node:test";
import { getProjectRepositoryBundle } from "../data/repository/project/repository-bundle.js";
import { ProjectStoreError } from "../data/repository/project/runtime-repository.js";
import { deleteProjectById } from "../services/project-admin-service.js";

test("deleteProjectById drains active runtime before removing project", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-project-delete-drain-"));
  const dataRoot = path.join(tempRoot, "data");
  const repositories = getProjectRepositoryBundle(dataRoot);
  const created = await repositories.projectRuntime.createProject({
    projectId: "delete-runtime-drain",
    name: "Delete Runtime Drain",
    workspacePath: tempRoot
  });
  await repositories.sessions.addSession(created.paths, created.project.projectId, {
    sessionId: "session-dev",
    role: "dev",
    status: "running",
    provider: "minimax",
    providerSessionId: "provider-session-dev"
  });

  let providerActive = true;
  const terminationCalls: string[] = [];

  const removed = await deleteProjectById(dataRoot, created.project.projectId, {
    repositories,
    orchestrator: {
      terminateSessionProcess: async (projectId, sessionId) => {
        terminationCalls.push(`${projectId}:${sessionId}`);
        providerActive = false;
        return {
          attempted: true,
          pid: null,
          result: "killed",
          message: "cancelled before delete"
        };
      }
    },
    providerRegistry: {
      isSessionActive: (_providerId, providerSessionId) =>
        providerActive && providerSessionId === "provider-session-dev"
    },
    pollIntervalMs: 1,
    sleep: async () => {}
  });

  assert.equal(removed.projectId, created.project.projectId);
  assert.deepEqual(terminationCalls, ["delete-runtime-drain:session-dev"]);
  await assert.rejects(async () => fs.access(created.paths.projectRootDir));
});

test("deleteProjectById refuses delete while provider runtime stays active", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-project-delete-busy-"));
  const dataRoot = path.join(tempRoot, "data");
  const repositories = getProjectRepositoryBundle(dataRoot);
  const created = await repositories.projectRuntime.createProject({
    projectId: "delete-runtime-busy",
    name: "Delete Runtime Busy",
    workspacePath: tempRoot
  });
  await repositories.sessions.addSession(created.paths, created.project.projectId, {
    sessionId: "session-dev",
    role: "dev",
    status: "running",
    provider: "minimax",
    providerSessionId: "provider-session-dev"
  });

  let nowMs = 0;

  await assert.rejects(
    async () =>
      deleteProjectById(dataRoot, created.project.projectId, {
        repositories,
        orchestrator: {
          terminateSessionProcess: async () => ({
            attempted: false,
            pid: null,
            result: "skipped_no_pid",
            message: "runner still active"
          })
        },
        providerRegistry: {
          isSessionActive: () => true
        },
        drainTimeoutMs: 3,
        pollIntervalMs: 1,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms;
        }
      }),
    (error) => {
      assert.ok(error instanceof ProjectStoreError);
      assert.equal(error.code, "PROJECT_RUNTIME_BUSY");
      return true;
    }
  );

  await fs.access(created.paths.projectRootDir);
});
