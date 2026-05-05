import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectRecord, SessionRecord } from "../domain/models.js";
import { OrchestratorSingleFlightGate } from "../services/orchestrator/shared/kernel/single-flight.js";
import {
  runProjectDispatchLoop,
  type ProjectDispatchLoopState
} from "../services/orchestrator/project/project-dispatch-loop.js";

test("project dispatch loop blocks when durable active lease count reaches concurrency cap", async () => {
  const project = {
    projectId: "project-1",
    roleMessageStatus: {}
  } as ProjectRecord;
  const session = {
    sessionId: "session-1",
    projectId: "project-1",
    role: "lead",
    status: "idle"
  } as SessionRecord;
  const state: ProjectDispatchLoopState = {
    project,
    paths: {
      projectRootDir: "project-root",
      sessionsFile: "project-root/sessions.json"
    } as any,
    input: { mode: "manual" },
    orderedSessions: [session],
    cursor: 0,
    rolePromptMap: new Map(),
    roleSummaryMap: new Map(),
    registeredAgentIds: [],
    forceBootstrappedSessionId: null,
    dispatchedRoles: new Set(),
    activeDispatchesAtLoopStart: 0,
    dispatchedThisLoop: 0
  };
  let selectionCalls = 0;

  const result = await runProjectDispatchLoop(
    {
      context: {
        dataRoot: "data",
        providerRegistry: {} as any,
        repositories: {
          sessions: {
            getSession: async () => session
          },
          projectRuntime: {
            getProject: async () => project
          }
        } as any,
        inFlightDispatchSessionKeys: new OrchestratorSingleFlightGate(),
        buildSessionDispatchKey: (projectId: string, sessionId: string) => `${projectId}:${sessionId}`,
        completionCleanup: async () => 0,
        maxConcurrentDispatches: 1,
        countActiveDispatchLeases: async () => 1
      } as any,
      launchAdapter: {
        launch: async () => {
          throw new Error("launch should not be called");
        }
      },
      selectionAdapter: {
        select: async () => {
          selectionCalls += 1;
          throw new Error("selection should not be called when cap is reached");
        }
      }
    },
    state,
    1
  );

  assert.equal(selectionCalls, 0);
  assert.equal(result.dispatchedCount, 0);
  assert.equal(result.results[0]?.outcome, "session_busy");
  assert.equal(result.results[0]?.reason, "max concurrent dispatches reached");
});
