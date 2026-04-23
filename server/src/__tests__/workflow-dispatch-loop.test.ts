import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkflowPreDispatchSessionTouchError,
  runWorkflowDispatchLoop,
  type WorkflowDispatchLoopState
} from "../services/orchestrator/workflow/workflow-dispatch-loop.js";
import { OrchestratorSingleFlightGate } from "../services/orchestrator/shared/kernel/single-flight.js";

function buildState(): WorkflowDispatchLoopState {
  return {
    runId: "run-1",
    run: {
      runId: "run-1",
      status: "running",
      autoDispatchEnabled: true,
      tasks: [{ taskId: "task-1", ownerRole: "lead" }]
    } as any,
    runtime: {
      initializedAt: "2026-04-23T10:00:00.000Z",
      updatedAt: "2026-04-23T10:00:00.000Z",
      transitionSeq: 1,
      tasks: [
        {
          taskId: "task-1",
          state: "READY",
          blockedBy: [],
          blockedReasons: [],
          lastTransitionAt: "2026-04-23T10:00:00.000Z",
          transitionCount: 1,
          transitions: [{ seq: 1, at: "2026-04-23T10:00:00.000Z", fromState: null, toState: "READY" }]
        }
      ]
    },
    sessions: [
      {
        sessionId: "session-1",
        role: "lead",
        status: "idle",
        provider: "minimax"
      }
    ] as any,
    role: "lead",
    sessionFilter: "session-1",
    taskFilter: "task-1",
    force: false,
    onlyIdle: true,
    requestId: "req-1",
    source: "manual",
    remaining: 3
  };
}

test("workflow dispatch loop aborts before launch when pre-dispatch session touch fails", async () => {
  const state = buildState();
  const launchCalls: unknown[] = [];
  const inboxRemovals: unknown[] = [];
  const auditEvents: Array<Record<string, unknown>> = [];

  await assert.rejects(
    () =>
      runWorkflowDispatchLoop(
        {
          context: {
            repositories: {
              sessions: {
                touchSession: async () => {
                  throw new Error("disk write failed");
                }
              },
              events: {
                appendEvent: async (_runId: string, event: Record<string, unknown>) => {
                  auditEvents.push(event);
                }
              },
              inbox: {
                removeInboxMessages: async (...args: unknown[]) => {
                  inboxRemovals.push(args);
                }
              }
            } as any,
            maxConcurrentDispatches: 2,
            inFlightDispatchSessionKeys: new OrchestratorSingleFlightGate(),
            buildRunSessionKey: (runId: string, sessionId: string) => `${runId}:${sessionId}`,
            runWorkflowTransaction: async <T>(_runId: string, operation: () => Promise<T>) => await operation(),
            ensureRuntime: async () => state.runtime,
            readConvergedRuntime: async () => state.runtime
          },
          launchAdapter: {
            launch: async (...args: unknown[]) => {
              launchCalls.push(args);
            }
          },
          selectionAdapter: {
            select: async () => ({
              status: "selected" as const,
              selection: {
                role: "lead",
                session: state.sessions[0],
                dispatchKind: "task" as const,
                taskId: "task-1",
                message: null,
                messageId: "msg-1",
                requestId: "req-1",
                selectedMessageIds: ["msg-1"],
                runtimeTask: state.runtime.tasks[0]
              }
            })
          },
          loadRunOrThrow: async () => state.run,
          handleLaunchError: () => {}
        },
        state,
        1
      ),
    (error: unknown) => {
      assert(error instanceof WorkflowPreDispatchSessionTouchError);
      assert.equal(error.code, "WORKFLOW_PRE_DISPATCH_SESSION_TOUCH_FAILED");
      assert.equal((error.cause as Error).message, "disk write failed");
      return true;
    }
  );

  assert.equal(launchCalls.length, 0);
  assert.equal(inboxRemovals.length, 0);
  assert.equal(state.sessions[0]?.status, "idle");
  assert.equal(state.remaining, 3);
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]?.eventType, "WORKFLOW_PRE_DISPATCH_SESSION_TOUCH_FAILED");
  assert.equal((auditEvents[0]?.payload as Record<string, unknown>).error, "disk write failed");
});

test("workflow dispatch loop still throws touch failure when audit append also fails", async () => {
  const state = buildState();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    await assert.rejects(
      () =>
        runWorkflowDispatchLoop(
          {
            context: {
              repositories: {
                sessions: {
                  touchSession: async () => {
                    throw new Error("session write failed");
                  }
                },
                events: {
                  appendEvent: async () => {
                    throw new Error("audit append failed");
                  }
                },
                inbox: {
                  removeInboxMessages: async () => {}
                }
              } as any,
              maxConcurrentDispatches: 2,
              inFlightDispatchSessionKeys: new OrchestratorSingleFlightGate(),
              buildRunSessionKey: (runId: string, sessionId: string) => `${runId}:${sessionId}`,
              runWorkflowTransaction: async <T>(_runId: string, operation: () => Promise<T>) => await operation(),
              ensureRuntime: async () => state.runtime,
              readConvergedRuntime: async () => state.runtime
            },
            launchAdapter: {
              launch: async () => {
                throw new Error("launch should not be called");
              }
            },
            selectionAdapter: {
              select: async () => ({
                status: "selected" as const,
                selection: {
                  role: "lead",
                  session: state.sessions[0],
                  dispatchKind: "task" as const,
                  taskId: "task-1",
                  message: null,
                  messageId: null,
                  requestId: "req-1",
                  selectedMessageIds: [],
                  runtimeTask: state.runtime.tasks[0]
                }
              })
            },
            loadRunOrThrow: async () => state.run,
            handleLaunchError: () => {}
          },
          state,
          1
        ),
      (error: unknown) => {
        assert(error instanceof WorkflowPreDispatchSessionTouchError);
        assert.equal((error.cause as Error).message, "session write failed");
        return true;
      }
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0] ?? ""), /pre-dispatch session touch failed/i);
});
