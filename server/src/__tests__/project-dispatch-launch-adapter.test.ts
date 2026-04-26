import assert from "node:assert/strict";
import test from "node:test";
import { ProjectDispatchLaunchAdapter } from "../services/orchestrator/project/project-dispatch-launch-adapter.js";
import { ProviderLaunchError, serializeProviderLaunchError } from "../services/provider-launch-error.js";

test("project dispatch launch adapter handles sync task dispatch and terminal event emission", async () => {
  const launchCalls: Array<{ providerId: string; input: Record<string, unknown> }> = [];
  const taskPatches: Array<{ taskId: string; patch: Record<string, unknown> }> = [];
  const runnerStarted: unknown[] = [];
  const runnerSucceeded: unknown[] = [];
  const retryableErrors: unknown[] = [];
  let releaseCount = 0;
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
          modelCommand: "codex",
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
      releasePendingMessagesForRole: async () => {
        releaseCount += 1;
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
      markRunnerBlocked: async () => null,
      markRunnerRetryableError: async (payload: unknown) => {
        retryableErrors.push(payload);
        return null;
      },
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
      provider: "codex"
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
  assert.equal(releaseCount, 0);
  assert.equal(retryableErrors.length, 0);
  assert.equal(fatalErrorCalled, false);
  assert.equal(runnerStarted.length, 1);
  assert.equal(runnerSucceeded.length, 1);
  assert.deepEqual(launchCalls, [
    {
      providerId: "codex",
      input: {
        sessionId: "session-1",
        prompt: "dispatch prompt",
        dataRoot: "C:\\memory",
        dispatchId: "dispatch-1",
        taskId: "task-1",
        activeTaskTitle: "Implement adapter",
        activeParentTaskId: "parent-1",
        activeRootTaskId: "root-1",
        activeRequestId: "req-1",
        parentRequestId: "req-1",
        agentRole: "dev",
        modelCommand: "codex",
        modelParams: { model: "gpt-test" }
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

test("project dispatch launch adapter does not reclassify timeout-killed runner exit as fatal", async () => {
  const fatalErrors: unknown[] = [];
  const retryableErrors: unknown[] = [];
  const successCalls: unknown[] = [];
  const emitted: Array<{ kind: string; details: unknown }> = [];

  const adapter = new ProjectDispatchLaunchAdapter(
    {
      dataRoot: "C:\\memory",
      providerRegistry: {
        launchProjectDispatch: async () => ({
          mode: "sync" as const,
          result: {
            runId: "run-timeout-tail",
            finishedAt: "2026-03-28T12:02:00.000Z",
            exitCode: 1,
            timedOut: false,
            sessionId: "provider-session-timeout-tail"
          }
        })
      } as any,
      repositories: {
        taskboard: {
          listTasks: async () => [{ taskId: "task-timeout-tail", state: "READY" }],
          patchTask: async () => {}
        },
        sessions: {
          touchSession: async () => {}
        },
        events: {
          appendEvent: async () => {},
          listEvents: async () => [
            {
              eventType: "RUNNER_TIMEOUT_SOFT",
              createdAt: "2026-03-28T12:01:00.000Z",
              sessionId: "session-timeout-tail",
              payload: {
                dispatch_id: "dispatch-timeout-tail",
                run_id: "run-timeout-tail"
              }
            },
            {
              eventType: "ORCHESTRATOR_DISPATCH_FINISHED",
              createdAt: "2026-03-28T12:01:01.000Z",
              sessionId: "session-timeout-tail",
              payload: {
                dispatchId: "dispatch-timeout-tail",
                runId: "run-timeout-tail",
                timedOut: true
              }
            }
          ]
        }
      } as any,
      eventAdapter: {
        appendStarted: async () => {},
        appendFinished: async (_scope: unknown, details: unknown) => {
          emitted.push({ kind: "finished", details });
        },
        appendFailed: async (_scope: unknown, details: unknown) => {
          emitted.push({ kind: "failed", details });
        }
      } as any
    },
    {
      now: () => "2026-03-28T12:00:00.000Z",
      createDispatchId: () => "dispatch-timeout-tail",
      getRuntimeSettings: async () => ({}) as any,
      prepareProjectDispatchLaunch: async () =>
        ({
          routingSnapshot: { routes: [] },
          prompt: "dispatch prompt",
          promptArtifactPath: "C:\\memory\\project-timeout\\prompts\\dispatch-timeout-tail.md",
          modelCommand: undefined,
          modelParams: {}
        }) as any,
      addPendingMessagesForRole: async () => ({ confirmedMessageIds: [], pendingConfirmedMessages: [] }) as any,
      confirmPendingMessagesForRole: async () => ({ confirmedMessageIds: [], pendingConfirmedMessages: [] }) as any,
      releasePendingMessagesForRole: async () => ({ confirmedMessageIds: [], pendingConfirmedMessages: [] }) as any,
      markRunnerStarted: async () => null,
      markRunnerSuccess: async (payload: unknown) => {
        successCalls.push(payload);
        return null;
      },
      markRunnerTimeout: async () => ({ escalated: false }) as any,
      markRunnerBlocked: async () => null,
      markRunnerRetryableError: async (payload: unknown) => {
        retryableErrors.push(payload);
        return null;
      },
      markRunnerFatalError: async (payload: unknown) => {
        fatalErrors.push(payload);
        return null;
      }
    }
  );

  const result = await adapter.launch({
    project: { projectId: "project-timeout-tail" } as any,
    paths: { projectRootDir: "C:\\memory\\project-timeout" } as any,
    session: {
      sessionId: "session-timeout-tail",
      role: "lead-a",
      provider: "codex"
    } as any,
    taskId: "task-timeout-tail",
    input: { mode: "manual" },
    dispatchKind: "task",
    selectedMessageIds: [],
    messages: [] as any,
    allTasks: [] as any,
    firstMessage: {
      envelope: {
        message_id: "msg-timeout-tail",
        correlation: {
          request_id: "req-timeout-tail"
        }
      }
    } as any,
    activeTask: null,
    rolePromptMap: new Map([["lead-a", "role prompt"]]),
    roleSummaryMap: new Map([["lead-a", "lead"]]),
    registeredAgentIds: ["lead-a"]
  });

  assert.equal(result.outcome, "dispatched");
  assert.equal(fatalErrors.length, 0);
  assert.equal(retryableErrors.length, 0);
  assert.equal(successCalls.length, 0);
  assert.equal(emitted.length, 0);
});

test("project dispatch launch adapter resumes codex only when provider session id is a real thread id", async () => {
  const launchCalls: Array<{ providerId: string; input: Record<string, unknown> }> = [];

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
              runId: "run-2",
              finishedAt: "2026-03-28T12:01:00.000Z",
              exitCode: 0,
              timedOut: false,
              sessionId: "019d7dab-c535-7e22-b8e2-3281bad09329"
            }
          };
        }
      } as any,
      repositories: {
        taskboard: {
          listTasks: async () => [{ taskId: "task-2", state: "READY" }],
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
        appendFinished: async () => {},
        appendFailed: async () => {}
      } as any
    },
    {
      now: () => "2026-03-28T12:00:00.000Z",
      createDispatchId: () => "dispatch-2",
      getRuntimeSettings: async () => ({}) as any,
      prepareProjectDispatchLaunch: async () =>
        ({
          routingSnapshot: { routes: [] },
          prompt: "dispatch prompt 2",
          promptArtifactPath: "C:\\memory\\project-2\\prompts\\dispatch-2.md",
          modelCommand: "codex",
          modelParams: { model: "gpt-test-2" }
        }) as any,
      addPendingMessagesForRole: async () =>
        ({
          confirmedMessageIds: [],
          pendingConfirmedMessages: []
        }) as any,
      releasePendingMessagesForRole: async () =>
        ({
          confirmedMessageIds: [],
          pendingConfirmedMessages: []
        }) as any,
      confirmPendingMessagesForRole: async () =>
        ({
          confirmedMessageIds: [],
          pendingConfirmedMessages: []
        }) as any,
      markRunnerStarted: async () => null,
      markRunnerSuccess: async () => null,
      markRunnerTimeout: async () => ({ escalated: false }) as any,
      markRunnerBlocked: async () => null,
      markRunnerRetryableError: async () => null,
      markRunnerFatalError: async () => null
    }
  );

  await adapter.launch({
    project: { projectId: "project-2" } as any,
    paths: { projectRootDir: "C:\\memory\\project-2" } as any,
    session: {
      sessionId: "session-2",
      providerSessionId: "019d7dab-c535-7e22-b8e2-3281bad09329",
      role: "dev",
      provider: "codex"
    } as any,
    taskId: "task-2",
    input: { mode: "manual" },
    dispatchKind: "task",
    selectedMessageIds: ["msg-2"],
    messages: [] as any,
    allTasks: [] as any,
    firstMessage: {
      envelope: {
        message_id: "msg-2",
        correlation: {
          request_id: "req-2"
        }
      }
    } as any,
    activeTask: {
      taskId: "task-2",
      title: "Implement resume handling",
      parentTaskId: "parent-2",
      rootTaskId: "root-2"
    } as any,
    rolePromptMap: new Map([["dev", "role prompt"]]),
    roleSummaryMap: new Map([["dev", "developer"]]),
    registeredAgentIds: ["dev"]
  });

  assert.equal(launchCalls.length, 1);
  assert.equal(launchCalls[0]?.input.resumeSessionId, "019d7dab-c535-7e22-b8e2-3281bad09329");
});

test("project dispatch launch adapter handles minimax async callbacks and terminal success", async () => {
  const runnerStarted: unknown[] = [];
  const runnerSucceeded: unknown[] = [];
  const emitted: Array<{ kind: string; scope: unknown; details: unknown }> = [];
  let addPendingCount = 0;
  let confirmCount = 0;
  let releaseCount = 0;

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
      releasePendingMessagesForRole: async () => {
        releaseCount += 1;
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
      markRunnerBlocked: async () => null,
      markRunnerRetryableError: async () => null,
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
  assert.equal(confirmCount, 1);
  assert.equal(releaseCount, 0);
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

test("project dispatch launch adapter blocks session on provider config error", async () => {
  const blocked: unknown[] = [];
  const fatal: unknown[] = [];
  const retryable: unknown[] = [];

  const adapter = new ProjectDispatchLaunchAdapter(
    {
      dataRoot: "C:\\memory",
      providerRegistry: {
        launchProjectDispatch: async () => {
          throw new Error("should not be called");
        }
      } as any,
      repositories: {
        taskboard: {
          listTasks: async () => [],
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
        appendFinished: async () => {},
        appendFailed: async () => {}
      } as any
    },
    {
      now: () => "2026-04-12T10:00:00.000Z",
      createDispatchId: () => "dispatch-blocked",
      getRuntimeSettings: async () => ({}) as any,
      prepareProjectDispatchLaunch: async () => {
        throw new ProviderLaunchError({
          code: "PROVIDER_MODEL_MISMATCH",
          category: "config",
          retryable: false,
          message: "Codex provider cannot use MiniMax model 'MiniMax-M2.5'.",
          nextAction: "Use a Codex model such as gpt-5.3-codex, or switch provider to minimax."
        });
      },
      addPendingMessagesForRole: async () => ({ confirmedMessageIds: [], pendingConfirmedMessages: [] }) as any,
      confirmPendingMessagesForRole: async () => ({ confirmedMessageIds: [], pendingConfirmedMessages: [] }) as any,
      releasePendingMessagesForRole: async () => ({ confirmedMessageIds: [], pendingConfirmedMessages: [] }) as any,
      markRunnerStarted: async () => null,
      markRunnerSuccess: async () => null,
      markRunnerTimeout: async () => ({ escalated: false }) as any,
      markRunnerBlocked: async (payload: unknown) => {
        blocked.push(payload);
        return null;
      },
      markRunnerRetryableError: async (payload: unknown) => {
        retryable.push(payload);
        return null;
      },
      markRunnerFatalError: async (payload: unknown) => {
        fatal.push(payload);
        return null;
      }
    } as any
  );

  const result = await adapter.launch({
    project: { projectId: "project-blocked" } as any,
    paths: { projectRootDir: "C:\\memory\\project-blocked" } as any,
    session: {
      sessionId: "session-blocked",
      role: "lead",
      provider: "codex"
    } as any,
    taskId: "task-blocked",
    input: { mode: "manual" },
    dispatchKind: "task",
    selectedMessageIds: ["msg-blocked"],
    messages: [] as any,
    allTasks: [] as any,
    firstMessage: {
      envelope: {
        message_id: "msg-blocked",
        correlation: {
          request_id: "req-blocked"
        }
      }
    } as any,
    activeTask: null,
    rolePromptMap: new Map(),
    roleSummaryMap: new Map(),
    registeredAgentIds: ["lead"]
  });

  assert.equal(result.outcome, "dispatch_failed");
  assert.equal(blocked.length, 1);
  assert.equal(retryable.length, 0);
  assert.equal(fatal.length, 0);
});

test("project dispatch launch adapter keeps message dispatch retryable after async minimax transient failure", async () => {
  const runnerStarted: unknown[] = [];
  const retryableErrors: unknown[] = [];
  const transientErrors: unknown[] = [];
  const fatalErrors: unknown[] = [];
  const emitted: Array<{ kind: string; details: unknown }> = [];
  let addPendingCount = 0;
  let confirmCount = 0;
  let releaseCount = 0;

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
          await callbacks?.wakeUpCallback?.("session-minimax-msg", "run-async-msg");
          await callbacks?.completionCallback?.(
            {
              finishedAt: "2026-03-28T12:05:00.000Z",
              exitCode: 1,
              timedOut: false,
              sessionId: "provider-session-async-msg",
              error: serializeProviderLaunchError(
                new ProviderLaunchError({
                  code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
                  category: "runtime",
                  retryable: true,
                  message: "MiniMax upstream returned transient status 529.",
                  nextAction: "Wait for cooldown and retry the same task/message dispatch.",
                  details: {
                    status: 529
                  }
                })
              )
            },
            "session-minimax-msg",
            "run-async-msg"
          );
          return {
            mode: "async" as const,
            runId: "run-async-msg"
          };
        }
      } as any,
      repositories: {
        taskboard: {
          listTasks: async () => [],
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
        appendFinished: async (_scope: unknown, details: unknown) => {
          emitted.push({ kind: "finished", details });
        },
        appendFailed: async (_scope: unknown, details: unknown) => {
          emitted.push({ kind: "failed", details });
        }
      } as any
    },
    {
      now: () => "2026-03-28T12:00:00.000Z",
      createDispatchId: () => "dispatch-async-msg",
      getRuntimeSettings: async () => ({ minimaxApiKey: "test-key" }) as any,
      prepareProjectDispatchLaunch: async () =>
        ({
          routingSnapshot: { routes: [] },
          prompt: "dispatch prompt",
          promptArtifactPath: "C:\\memory\\project-msg\\prompts\\dispatch-async-msg.md",
          modelCommand: undefined,
          modelParams: {}
        }) as any,
      addPendingMessagesForRole: async () => {
        addPendingCount += 1;
        return { confirmedMessageIds: [], pendingConfirmedMessages: [] } as any;
      },
      confirmPendingMessagesForRole: async () => {
        confirmCount += 1;
        return { confirmedMessageIds: [], pendingConfirmedMessages: [] } as any;
      },
      releasePendingMessagesForRole: async () => {
        releaseCount += 1;
        return { confirmedMessageIds: [], pendingConfirmedMessages: [] } as any;
      },
      markRunnerStarted: async (payload: unknown) => {
        runnerStarted.push(payload);
        return null;
      },
      markRunnerSuccess: async () => null,
      markRunnerTimeout: async () => ({ escalated: false }) as any,
      markRunnerBlocked: async () => null,
      markRunnerRetryableError: async (payload: unknown) => {
        retryableErrors.push(payload);
        return null;
      },
      markRunnerTransientError: async (payload: unknown) => {
        transientErrors.push(payload);
        return null;
      },
      markRunnerFatalError: async (payload: unknown) => {
        fatalErrors.push(payload);
        return null;
      }
    }
  );

  const result = await adapter.launch({
    project: { projectId: "project-msg" } as any,
    paths: { projectRootDir: "C:\\memory\\project-msg" } as any,
    session: {
      sessionId: "session-msg",
      role: "arch-b",
      provider: "minimax"
    } as any,
    taskId: "task-discuss-alignment",
    input: { mode: "manual" },
    dispatchKind: "message",
    selectedMessageIds: ["msg-discuss-1"],
    messages: [] as any,
    allTasks: [] as any,
    firstMessage: {
      envelope: {
        message_id: "msg-discuss-1",
        correlation: {
          request_id: "req-msg-1"
        }
      }
    } as any,
    activeTask: null,
    rolePromptMap: new Map([["arch-b", "role prompt"]]),
    roleSummaryMap: new Map([["arch-b", "architect b"]]),
    registeredAgentIds: ["arch-b"]
  });

  assert.equal(result.outcome, "dispatched");
  assert.equal(addPendingCount, 1);
  assert.equal(confirmCount, 0);
  assert.equal(releaseCount, 1);
  assert.equal(runnerStarted.length, 1);
  assert.equal(retryableErrors.length, 0);
  assert.equal(transientErrors.length, 1);
  assert.equal(fatalErrors.length, 0);
  assert.deepEqual(emitted, [
    {
      kind: "failed",
      details: {
        dispatchId: "dispatch-async-msg",
        dispatchKind: "message",
        requestId: "req-msg-1",
        mode: "manual",
        messageIds: ["msg-discuss-1"],
        runId: "run-async-msg",
        exitCode: 1,
        timedOut: false,
        startedAt: "2026-03-28T12:00:00.000Z",
        finishedAt: "2026-03-28T12:05:00.000Z",
        error: "MiniMax upstream returned transient status 529."
      }
    }
  ]);
});

test("project dispatch launch adapter keeps task dispatch retryable after async minimax transient failure", async () => {
  const transientErrors: unknown[] = [];
  const fatalErrors: unknown[] = [];

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
          await callbacks?.wakeUpCallback?.("session-minimax-task", "run-async-task");
          await callbacks?.completionCallback?.(
            {
              finishedAt: "2026-03-28T12:05:00.000Z",
              exitCode: 1,
              timedOut: false,
              sessionId: "provider-session-async-task",
              error: serializeProviderLaunchError(
                new ProviderLaunchError({
                  code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
                  category: "runtime",
                  retryable: true,
                  message: "MiniMax upstream returned transient status 529.",
                  nextAction: "Wait for cooldown and retry the same task/message dispatch.",
                  details: {
                    status: 529
                  }
                })
              )
            },
            "session-minimax-task",
            "run-async-task"
          );
          return {
            mode: "async" as const,
            runId: "run-async-task"
          };
        }
      } as any,
      repositories: {
        taskboard: {
          listTasks: async () => [{ taskId: "task-async-529", state: "READY" }],
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
        appendFinished: async () => {},
        appendFailed: async () => {}
      } as any
    },
    {
      now: () => "2026-03-28T12:00:00.000Z",
      createDispatchId: () => "dispatch-async-task",
      getRuntimeSettings: async () => ({ minimaxApiKey: "test-key" }) as any,
      prepareProjectDispatchLaunch: async () =>
        ({
          routingSnapshot: { routes: [] },
          prompt: "dispatch prompt",
          promptArtifactPath: "C:\\memory\\project-task\\prompts\\dispatch-async-task.md",
          modelCommand: undefined,
          modelParams: {}
        }) as any,
      addPendingMessagesForRole: async () => ({ confirmedMessageIds: [], pendingConfirmedMessages: [] }) as any,
      confirmPendingMessagesForRole: async () => ({ confirmedMessageIds: [], pendingConfirmedMessages: [] }) as any,
      releasePendingMessagesForRole: async () => ({ confirmedMessageIds: [], pendingConfirmedMessages: [] }) as any,
      markRunnerStarted: async () => null,
      markRunnerSuccess: async () => null,
      markRunnerTimeout: async () => ({ escalated: false }) as any,
      markRunnerBlocked: async () => null,
      markRunnerRetryableError: async () => null,
      markRunnerTransientError: async (payload: unknown) => {
        transientErrors.push(payload);
        return null;
      },
      markRunnerFatalError: async (payload: unknown) => {
        fatalErrors.push(payload);
        return null;
      }
    }
  );

  const result = await adapter.launch({
    project: { projectId: "project-task" } as any,
    paths: { projectRootDir: "C:\\memory\\project-task" } as any,
    session: {
      sessionId: "session-task",
      role: "lead",
      provider: "minimax"
    } as any,
    taskId: "task-async-529",
    input: { mode: "manual" },
    dispatchKind: "task",
    selectedMessageIds: [],
    messages: [] as any,
    allTasks: [] as any,
    firstMessage: {
      envelope: {
        message_id: "msg-task",
        correlation: {
          request_id: "req-task"
        }
      }
    } as any,
    activeTask: {
      taskId: "task-async-529",
      title: "Task 529"
    } as any,
    rolePromptMap: new Map([["lead", "role prompt"]]),
    roleSummaryMap: new Map([["lead", "lead"]]),
    registeredAgentIds: ["lead"]
  });

  assert.equal(result.outcome, "dispatched");
  assert.equal(transientErrors.length, 1);
  assert.equal(fatalErrors.length, 0);
});

test("project dispatch launch adapter releases message dispatch when minimax async launch throws before run creation", async () => {
  const retryableErrors: unknown[] = [];
  const blockedErrors: unknown[] = [];
  const fatalErrors: unknown[] = [];
  let addPendingCount = 0;
  let confirmCount = 0;
  let releaseCount = 0;

  const adapter = new ProjectDispatchLaunchAdapter(
    {
      dataRoot: "C:\\memory",
      providerRegistry: {
        launchProjectDispatch: async () => {
          throw new Error("529 overloaded_error");
        }
      } as any,
      repositories: {
        taskboard: {
          listTasks: async () => [],
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
        appendFinished: async () => {},
        appendFailed: async () => {}
      } as any
    },
    {
      now: () => "2026-03-28T12:00:00.000Z",
      createDispatchId: () => "dispatch-async-throw",
      getRuntimeSettings: async () => ({ minimaxApiKey: "test-key" }) as any,
      prepareProjectDispatchLaunch: async () =>
        ({
          routingSnapshot: { routes: [] },
          prompt: "dispatch prompt",
          promptArtifactPath: "C:\\memory\\project-msg\\prompts\\dispatch-async-throw.md",
          modelCommand: undefined,
          modelParams: {}
        }) as any,
      addPendingMessagesForRole: async () => {
        addPendingCount += 1;
        return { confirmedMessageIds: [], pendingConfirmedMessages: [] } as any;
      },
      confirmPendingMessagesForRole: async () => {
        confirmCount += 1;
        return { confirmedMessageIds: [], pendingConfirmedMessages: [] } as any;
      },
      releasePendingMessagesForRole: async () => {
        releaseCount += 1;
        return { confirmedMessageIds: [], pendingConfirmedMessages: [] } as any;
      },
      markRunnerStarted: async () => null,
      markRunnerSuccess: async () => null,
      markRunnerTimeout: async () => ({ escalated: false }) as any,
      markRunnerBlocked: async (payload: unknown) => {
        blockedErrors.push(payload);
        return null;
      },
      markRunnerRetryableError: async (payload: unknown) => {
        retryableErrors.push(payload);
        return null;
      },
      markRunnerFatalError: async (payload: unknown) => {
        fatalErrors.push(payload);
        return null;
      }
    }
  );

  const result = await adapter.launch({
    project: { projectId: "project-msg" } as any,
    paths: { projectRootDir: "C:\\memory\\project-msg" } as any,
    session: {
      sessionId: "session-msg",
      role: "arch-b",
      provider: "minimax"
    } as any,
    taskId: "task-discuss-alignment",
    input: { mode: "manual" },
    dispatchKind: "message",
    selectedMessageIds: ["msg-discuss-1"],
    messages: [] as any,
    allTasks: [] as any,
    firstMessage: {
      envelope: {
        message_id: "msg-discuss-1",
        correlation: {
          request_id: "req-msg-1"
        }
      }
    } as any,
    activeTask: null,
    rolePromptMap: new Map([["arch-b", "role prompt"]]),
    roleSummaryMap: new Map([["arch-b", "architect b"]]),
    registeredAgentIds: ["arch-b"]
  });

  assert.equal(result.outcome, "dispatch_failed");
  assert.equal(addPendingCount, 1);
  assert.equal(confirmCount, 0);
  assert.equal(releaseCount, 1);
  assert.equal(retryableErrors.length, 1);
  assert.equal(blockedErrors.length, 0);
  assert.equal(fatalErrors.length, 0);
});

test("project dispatch launch adapter releases message dispatch if terminal lifecycle fails after successful run", async () => {
  const retryableErrors: unknown[] = [];
  const fatalErrors: unknown[] = [];
  let addPendingCount = 0;
  let confirmCount = 0;
  let releaseCount = 0;

  const adapter = new ProjectDispatchLaunchAdapter(
    {
      dataRoot: "C:\\memory",
      providerRegistry: {
        launchProjectDispatch: async () => ({
          mode: "sync" as const,
          result: {
            runId: "run-sync-msg",
            exitCode: 0,
            timedOut: false,
            finishedAt: "2026-03-28T12:05:00.000Z",
            sessionId: "provider-session-sync-msg"
          }
        })
      } as any,
      repositories: {
        taskboard: {
          listTasks: async () => [],
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
        appendFinished: async () => {},
        appendFailed: async () => {}
      } as any
    },
    {
      now: () => "2026-03-28T12:00:00.000Z",
      createDispatchId: () => "dispatch-sync-msg",
      getRuntimeSettings: async () => ({ codexCliCommand: "codex" }) as any,
      prepareProjectDispatchLaunch: async () =>
        ({
          routingSnapshot: { routes: [] },
          prompt: "dispatch prompt",
          promptArtifactPath: "C:\\memory\\project-msg\\prompts\\dispatch-sync-msg.md",
          modelCommand: undefined,
          modelParams: {}
        }) as any,
      addPendingMessagesForRole: async () => {
        addPendingCount += 1;
        return { confirmedMessageIds: [], pendingConfirmedMessages: [] } as any;
      },
      confirmPendingMessagesForRole: async () => {
        confirmCount += 1;
        return { confirmedMessageIds: [], pendingConfirmedMessages: [] } as any;
      },
      releasePendingMessagesForRole: async () => {
        releaseCount += 1;
        return { confirmedMessageIds: [], pendingConfirmedMessages: [] } as any;
      },
      markRunnerStarted: async () => null,
      markRunnerSuccess: async () => {
        throw new Error("session persistence failed");
      },
      markRunnerTimeout: async () => ({ escalated: false }) as any,
      markRunnerBlocked: async () => null,
      markRunnerRetryableError: async (payload: unknown) => {
        retryableErrors.push(payload);
        return null;
      },
      markRunnerFatalError: async (payload: unknown) => {
        fatalErrors.push(payload);
        return null;
      }
    }
  );

  const result = await adapter.launch({
    project: { projectId: "project-msg" } as any,
    paths: { projectRootDir: "C:\\memory\\project-msg" } as any,
    session: {
      sessionId: "session-msg",
      role: "arch-b",
      provider: "codex"
    } as any,
    taskId: "task-discuss-alignment",
    input: { mode: "manual" },
    dispatchKind: "message",
    selectedMessageIds: ["msg-discuss-1"],
    messages: [] as any,
    allTasks: [] as any,
    firstMessage: {
      envelope: {
        message_id: "msg-discuss-1",
        correlation: {
          request_id: "req-msg-1"
        }
      }
    } as any,
    activeTask: null,
    rolePromptMap: new Map([["arch-b", "role prompt"]]),
    roleSummaryMap: new Map([["arch-b", "architect b"]]),
    registeredAgentIds: ["arch-b"]
  });

  assert.equal(result.outcome, "dispatch_failed");
  assert.equal(addPendingCount, 1);
  assert.equal(confirmCount, 0);
  assert.equal(releaseCount, 1);
  assert.equal(retryableErrors.length, 1);
  assert.equal(fatalErrors.length, 0);
});
