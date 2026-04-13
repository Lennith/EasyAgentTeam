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
