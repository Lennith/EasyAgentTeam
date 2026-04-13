import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkflowAuthoritativeSession } from "../services/orchestrator/workflow/workflow-session-authority.js";

test("workflow authoritative session auto-creation uses configured role provider", async () => {
  const upsertCalls: Array<Record<string, unknown>> = [];
  const patchCalls: Array<Record<string, unknown>> = [];
  const runRecord = {
    runId: "run-codex-authority",
    roleSessionMap: {},
    agentModelConfigs: {
      dev_impl: {
        provider_id: "codex"
      }
    }
  } as any;

  const authoritative = await resolveWorkflowAuthoritativeSession(
    {
      repositories: {
        workflowRuns: {
          getRun: async () => runRecord,
          patchRun: async (_runId: string, patch: Record<string, unknown>) => {
            patchCalls.push(patch);
            runRecord.roleSessionMap = (patch.roleSessionMap as Record<string, string> | undefined) ?? {};
            return runRecord;
          }
        },
        sessions: {
          upsertSession: async (_runId: string, input: Record<string, unknown>) => {
            upsertCalls.push(input);
            return {
              created: true,
              session: {
                sessionId: String(input.sessionId),
                runId: "run-codex-authority",
                role: String(input.role),
                status: String(input.status),
                provider: input.provider
              }
            };
          },
          getSession: async () => null
        }
      } as any,
      providerRegistry: {
        isSessionActive: () => false
      } as any
    },
    {
      runId: "run-codex-authority",
      role: "dev_impl",
      sessions: [],
      runRecord
    }
  );

  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0]?.provider, "codex");
  assert.equal(authoritative?.provider, "codex");
  assert.equal(authoritative?.role, "dev_impl");
  assert.equal(typeof authoritative?.sessionId, "string");
  assert.equal(runRecord.roleSessionMap.dev_impl, authoritative?.sessionId);
  assert.equal(patchCalls.length, 1);
});

test("workflow authoritative session recreation inherits provider from historical mapped session", async () => {
  const upsertCalls: Array<Record<string, unknown>> = [];
  const runRecord = {
    runId: "run-historical-provider",
    roleSessionMap: {
      interaction_designer: "session-old-codex"
    }
  } as any;

  const authoritative = await resolveWorkflowAuthoritativeSession(
    {
      repositories: {
        workflowRuns: {
          getRun: async () => runRecord,
          patchRun: async (_runId: string, patch: Record<string, unknown>) => {
            runRecord.roleSessionMap = (patch.roleSessionMap as Record<string, string> | undefined) ?? {};
            return runRecord;
          }
        },
        sessions: {
          upsertSession: async (_runId: string, input: Record<string, unknown>) => {
            upsertCalls.push(input);
            return {
              created: true,
              session: {
                sessionId: String(input.sessionId),
                runId: "run-historical-provider",
                role: String(input.role),
                status: String(input.status),
                provider: input.provider
              }
            };
          },
          getSession: async () => null
        }
      } as any,
      providerRegistry: {
        isSessionActive: () => false
      } as any
    },
    {
      runId: "run-historical-provider",
      role: "interaction_designer",
      sessions: [
        {
          sessionId: "session-old-codex",
          role: "interaction_designer",
          status: "dismissed",
          provider: "codex",
          createdAt: "2026-04-13T07:00:00.000Z",
          updatedAt: "2026-04-13T07:05:00.000Z",
          lastActiveAt: "2026-04-13T07:05:00.000Z"
        }
      ] as any,
      runRecord
    }
  );

  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0]?.provider, "codex");
  assert.equal(authoritative?.provider, "codex");
  assert.equal(runRecord.roleSessionMap.interaction_designer, authoritative?.sessionId);
});
