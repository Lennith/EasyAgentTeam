import assert from "node:assert/strict";
import test from "node:test";
import { prepareWorkflowDispatchLaunch } from "../services/orchestrator/workflow/workflow-dispatch-launch-preparation.js";

test("workflow dispatch launch preparation resolves fallback role prompt, skills, and provider config", async () => {
  const workspaceCalls: Array<{ projectId: string; agentIds: string[] }> = [];

  const prepared = await prepareWorkflowDispatchLaunch(
    {
      dataRoot: "C:\\memory",
      run: {
        runId: "run-1",
        name: "Workflow Run",
        workspacePath: "D:\\AgentWorkSpace\\Workflow1",
        createdAt: "2026-03-28T12:00:00.000Z",
        updatedAt: "2026-03-28T12:00:00.000Z",
        tasks: [{ ownerRole: "qa" }]
      } as any,
      role: "dev",
      session: {
        sessionId: "session-1",
        role: "dev",
        provider: "codex"
      } as any
    },
    {
      listAgents: async () =>
        [
          {
            agentId: "dev",
            prompt: "   ",
            summary: "developer",
            skillList: ["skill-list-1"],
            defaultModelParams: {
              model: "gpt-5.3-codex",
              effort: "medium"
            }
          }
        ] as any,
      resolveSkillIdsForAgent: async (_dataRoot: string, skillList: string[] | undefined) => {
        assert.deepEqual(skillList, ["skill-list-1"]);
        return ["skill-a"];
      },
      resolveImportedSkillPromptSegments: async (_dataRoot: string, skillIds: string[] | undefined) => {
        assert.deepEqual(skillIds, ["skill-a"]);
        return { segments: ["skill prompt"] } as any;
      },
      getRuntimeSettings: async () =>
        ({
          minimaxTokenLimit: 2048,
          minimaxMaxOutputTokens: 512
        }) as any,
      ensureAgentWorkspaces: async (project: { projectId: string; agentIds?: string[] }) => {
        workspaceCalls.push({ projectId: project.projectId, agentIds: project.agentIds ?? [] });
        return { created: [], updated: [] } as any;
      },
      buildDefaultRolePrompt: (role: string) => `default:${role}`
    }
  );

  assert.deepEqual(workspaceCalls, [
    {
      projectId: "workflow-run-1",
      agentIds: ["qa", "dev"]
    }
  ]);
  assert.equal(prepared.rolePrompt, "default:dev");
  assert.deepEqual(prepared.requestedSkillIds, ["skill-a"]);
  assert.deepEqual(prepared.importedSkillPrompt, { segments: ["skill prompt"] });
  assert.equal(prepared.providerId, "codex");
  assert.equal(prepared.model, "gpt-5.3-codex");
  assert.equal(prepared.reasoningEffort, "medium");
  assert.equal(prepared.tokenLimit, 2048);
  assert.equal(prepared.maxOutputTokens, 512);
});

test("workflow dispatch launch preparation applies MiniMax agent model without global settings patch", async () => {
  const prepared = await prepareWorkflowDispatchLaunch(
    {
      dataRoot: "C:\\memory",
      run: {
        runId: "run-2",
        name: "Workflow Run",
        workspacePath: "D:\\AgentWorkSpace\\Workflow2",
        createdAt: "2026-04-25T12:00:00.000Z",
        updatedAt: "2026-04-25T12:00:00.000Z",
        tasks: [{ ownerRole: "dev" }]
      } as any,
      role: "dev",
      session: {
        sessionId: "session-2",
        role: "dev",
        provider: "minimax"
      } as any
    },
    {
      listAgents: async () =>
        [
          {
            agentId: "dev",
            prompt: "Developer",
            defaultModelParams: {
              model: "MiniMax-M2.7-High-speed",
              effort: "high"
            }
          }
        ] as any,
      resolveSkillIdsForAgent: async () => [],
      resolveImportedSkillPromptSegments: async () => ({ segments: [] }) as any,
      getRuntimeSettings: async () =>
        ({
          minimaxModel: "MiniMax-M2.5-High-speed",
          minimaxTokenLimit: 2048,
          minimaxMaxOutputTokens: 512,
          providers: {
            minimax: {
              model: "MiniMax-M2.5-High-speed",
              tokenLimit: 4096,
              maxOutputTokens: 1024
            }
          }
        }) as any,
      ensureAgentWorkspaces: async () => ({ created: [], updated: [] }) as any,
      buildDefaultRolePrompt: (role: string) => `default:${role}`
    }
  );

  assert.equal(prepared.providerId, "minimax");
  assert.equal(prepared.model, "MiniMax-M2.7-High-speed");
  assert.equal(prepared.reasoningEffort, "high");
  assert.equal(prepared.tokenLimit, 4096);
  assert.equal(prepared.maxOutputTokens, 1024);
});
