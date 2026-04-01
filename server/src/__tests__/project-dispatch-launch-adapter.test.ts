import assert from "node:assert/strict";
import test from "node:test";
import { ProjectDispatchLaunchAdapter } from "../services/orchestrator/project-dispatch-launch-adapter.js";

test("project dispatch launch adapter handles sync task dispatch and terminal event emission", async () => {
  const launchCalls: Array<{ providerId: string; input: Record<string, unknown> }> = [];
  const taskPatches: Array<{ taskId: string; patch: Record<string, unknown> }> = [];
  const runnerStarted: unknown[] = [];
  const runnerSucceeded: unknown[] = [];
  const emitted: Array<{ kind: string; scope: unknown; details: unknown }> = [];
  let confirmCount = 0;
  let fatalErrorCalled = false;

  const adapter = new ProjectDispatchLaunchAdapter(
    {
      dataRoot: "C:\\memory",
      providerRegistry: {
        launchProjectDispatch: async (
          providerId: string,
          _project: unknown,
          _paths: unknown,
          input: Record<string, unknown>
        ) => {
          launchCalls.push({ providerId, input });
          return {
            mode: "sync" as const,
            result: {
              runId: "run-1",
              finishedAt: "2026-03-28T12:00:00.000Z",
              exitCode: 0,
              timedOut: false,
              sessionId: "provider-session-1"
            }
          };
        }
      } as any,
      repositories: {
        taskboard: {
          listTasks: async () => [{ taskId: "task-1", state: "READY" }],
          patchTask: async (_paths: unknown, _projectId: string, taskId: string, patch: Record<string, unknown>) => {
            taskPatches.push({ taskId, patch });
          }
        },
        sessions: {
          touchSession: async () => {}
        },
        events: {
          appendEvent: async () => {},
          listEvents: async () => []
        }
      } as any,
      eventAdapter: {
        appendStarted: async () => {},
        appendFinished: async (scope: unknown, details: unknown) => {
          emitted.push({ kind: "finished", scope, details });
        },
        appendFailed: async (scope: unknown, details: unknown) => {
          emitted.push({ kind: "failed", scope, details });
        }
      } as any
    },
    {
      now: () => "2026-03-28T11:59:00.000Z",
      createDispatchId: () => "dispatch-1",
      getRuntimeSettings: async () => ({}) as any,
      prepareProjectDispatchLaunch: async () =>
        ({
          routingSnapshot: { routes: [] },
          prompt: "dispatch prompt",
          promptArtifactPath: "C:\\memory\\project-1\\prompts\\dispatch-1.md",
          modelCommand: "trae",
          modelParams: { model: "gpt-test" }
        }) as any,
      addPendingMessagesForRole: async () =>
        ({
          confirmedMessageIds: [],
          pendingConfirmedMessages: []
        }) as any,
      confirmPendingMessagesForRole: async () => {
        confirmCount += 1;
        return {
          confirmedMessageIds: [],
          pendingConfirmedMessages: []
        } as any;
      },
      markRunnerStarted: async (payload: unknown) => {
        runnerStarted.push(payload);
        return null;
      },
      markRunnerSuccess: async (payload: unknown) => {
        runnerSucceeded.push(payload);
        return null;
      },
      markRunnerTimeout: async () => ({ escalated: false }) as any,
      markRunnerFatalError: async () => {
        fatalErrorCalled = true;
        return null;
      }
    }
  );

  const result = await adapter.launch({
    project: { projectId: "project-1" } as any,
    paths: { projectRootDir: "C:\\memory\\project-1" } as any,
    session: {
      sessionId: "session-1",
      role: "dev",
      provider: "trae"
    } as any,
    taskId: "task-1",
    input: { mode: "manual" },
    dispatchKind: "task",
    selectedMessageIds: ["msg-1"],
    messages: [] as any,
    allTasks: [] as any,
    firstMessage: {
      envelope: {
        message_id: "msg-1",
        correlation: {
          request_id: "req-1"
        }
      }
    } as any,
    activeTask: {
      taskId: "task-1",
      title: "Implement adapter",
      parentTaskId: "parent-1",
      rootTaskId: "root-1"
    } as any,
    rolePromptMap: new Map([["dev", "role prompt"]]),
    roleSummaryMap: new Map([["dev", "developer"]]),
    registeredAgentIds: ["dev"]
  });

  assert.equal(result.outcome, "dispatched");
  assert.equal(result.runId, "run-1");
  assert.equal(confirmCount, 1);
  assert.equal(fatalErrorCalled, false);
  assert.equal(runnerStarted.length, 1);
  assert.equal(runnerSucceeded.length, 1);
  assert.deepEqual(launchCalls, [
    {
      providerId: "trae",
      input: {
        sessionId: "session-1",
        prompt: "dispatch prompt",
        dispatchId: "dispatch-1",
        taskId: "task-1",
        activeTaskTitle: "Implement adapter",
        activeParentTaskId: "parent-1",
        activeRootTaskId: "root-1",
        activeRequestId: "req-1",
        parentRequestId: "req-1",
        agentRole: "dev",
        modelCommand: "trae",
        modelParams: { model: "gpt-test" },
        resumeSessionId: "session-1"
      }
    }
  ]);
  assert.deepEqual(taskPatches, [
    {
      taskId: "task-1",
      patch: {
        state: "DISPATCHED",
        grantedAt: taskPatches[0]?.patch.grantedAt
      }
    }
  ]);
  assert.equal(typeof (taskPatches[0]?.patch.grantedAt as string | undefined), "string");
  assert.deepEqual(emitted, [
    {
      kind: "finished",
      scope: {
        project: { projectId: "project-1" },
        paths: { projectRootDir: "C:\\memory\\project-1" },
        sessionId: "session-1",
        taskId: "task-1"
      },
      details: {
        dispatchId: "dispatch-1",
        dispatchKind: "task",
        requestId: "req-1",
        mode: "manual",
        messageIds: ["msg-1"],
        runId: "run-1",
        exitCode: 0,
        timedOut: false,
        startedAt: "2026-03-28T11:59:00.000Z",
        finishedAt: "2026-03-28T12:00:00.000Z"
      }
    }
  ]);
});

test("project dispatch launch adapter handles minimax async callbacks and terminal success", async () => {
  const runnerStarted: unknown[] = [];
  const runnerSucceeded: unknown[] = [];
  const emitted: Array<{ kind: string; scope: unknown; details: unknown }> = [];
  let addPendingCount = 0;
  let confirmCount = 0;

  const adapter = new ProjectDispatchLaunchAdapter(
    {
      dataRoot: "C:\\memory",
      providerRegistry: {
        launchProjectDispatch: async (
          providerId: string,
          _project: unknown,
          _paths: unknown,
          _input: Record<string, unknown>,
          _runtimeSettings: unknown,
          callbacks?: {
            wakeUpCallback?(sessionId: string, runId: string): Promise<void>;
            completionCallback?(result: any, sessionId: string, runId: string): Promise<void>;
          }
        ) => {
          assert.equal(providerId, "minimax");
          await callbacks?.wakeUpCallback?.("session-minimax-1", "run-async-1");
          await callbacks?.completionCallback?.(
            {
              finishedAt: "2026-03-28T12:05:00.000Z",
              exitCode: 0,
              timedOut: false,
              sessionId: "provider-session-async-1"
            },
            "session-minimax-1",
            "run-async-1"
          );
          return {
            mode: "async" as const,
            runId: "run-async-1"
          };
        }
      } as any,
      repositories: {
        taskboard: {
          listTasks: async () => [{ taskId: "task-async-1", state: "READY" }],
          patchTask: async () => {}
        },
        sessions: {
          touchSession: async () => {}
        },
        events: {
          appendEvent: async () => {},
          listEvents: async () => []
        }
      } as any,
      eventAdapter: {
        appendStarted: async () => {},
        appendFinished: async (scope: unknown, details: unknown) => {
          emitted.push({ kind: "finished", scope, details });
        },
        appendFailed: async (scope: unknown, details: unknown) => {
          emitted.push({ kind: "failed", scope, details });
        }
      } as any
    },
    {
      now: () => "2026-03-28T12:00:00.000Z",
      createDispatchId: () => "dispatch-async-1",
      getRuntimeSettings: async () => ({ minimaxApiKey: "test-key" }) as any,
      prepareProjectDispatchLaunch: async () =>
        ({
          routingSnapshot: { routes: [] },
          prompt: "dispatch prompt",
          promptArtifactPath: "C:\\memory\\project-1\\prompts\\dispatch-async-1.md",
          modelCommand: undefined,
          modelParams: {}
        }) as any,
      addPendingMessagesForRole: async () => {
        addPendingCount += 1;
        return {
          confirmedMessageIds: [],
          pendingConfirmedMessages: []
        } as any;
      },
      confirmPendingMessagesForRole: async () => {
        confirmCount += 1;
        return {
          confirmedMessageIds: [],
          pendingConfirmedMessages: []
        } as any;
      },
      markRunnerStarted: async (payload: unknown) => {
        runnerStarted.push(payload);
        return null;
      },
      markRunnerSuccess: async (payload: unknown) => {
        runnerSucceeded.push(payload);
        return null;
      },
      markRunnerTimeout: async () => ({ escalated: false }) as any,
      markRunnerFatalError: async () => null
    }
  );

  const result = await adapter.launch({
    project: { projectId: "project-1" } as any,
    paths: { projectRootDir: "C:\\memory\\project-1" } as any,
    session: {
      sessionId: "session-1",
      role: "dev",
      provider: "minimax"
    } as any,
    taskId: "task-async-1",
    input: { mode: "manual" },
    dispatchKind: "task",
    selectedMessageIds: ["msg-1"],
    messages: [] as any,
    allTasks: [] as any,
    firstMessage: {
      envelope: {
        message_id: "msg-1",
        correlation: {
          request_id: "req-async-1"
        }
      }
    } as any,
    activeTask: {
      taskId: "task-async-1",
      title: "Async task"
    } as any,
    rolePromptMap: new Map([["dev", "role prompt"]]),
    roleSummaryMap: new Map([["dev", "developer"]]),
    registeredAgentIds: ["dev"]
  });

  assert.equal(result.outcome, "dispatched");
  assert.equal(result.runId, "run-async-1");
  assert.equal(addPendingCount, 1);
  assert.equal(confirmCount, 2);
  assert.equal(runnerStarted.length, 1);
  assert.equal(runnerSucceeded.length, 1);
  assert.deepEqual(emitted, [
    {
      kind: "finished",
      scope: {
        project: { projectId: "project-1" },
        paths: { projectRootDir: "C:\\memory\\project-1" },
        sessionId: "session-minimax-1",
        taskId: "task-async-1"
      },
      details: {
        dispatchId: "dispatch-async-1",
        dispatchKind: "task",
        requestId: "req-async-1",
        mode: "manual",
        messageIds: ["msg-1"],
        runId: "run-async-1",
        exitCode: 0,
        timedOut: false,
        startedAt: "2026-03-28T12:00:00.000Z",
        finishedAt: "2026-03-28T12:05:00.000Z"
      }
    }
  ]);
});
