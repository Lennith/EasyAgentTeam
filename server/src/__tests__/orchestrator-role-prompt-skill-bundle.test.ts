import assert from "node:assert/strict";
import test from "node:test";
import { resolveOrchestratorRolePromptSkillBundle } from "../services/orchestrator/shared/role-prompt-skill-bundle.js";

test("orchestrator role prompt skill bundle resolves prompt and imported skill segments", async () => {
  const bundle = await resolveOrchestratorRolePromptSkillBundle(
    {
      dataRoot: "C:\\memory",
      role: "dev"
    },
    {
      listAgents: async () =>
        [
          {
            agentId: "dev",
            prompt: "you are dev",
            skillList: ["skill-list-1"]
          }
        ] as any,
      resolveSkillIdsForAgent: async (_dataRoot: string, listIdsRaw: string[] | undefined) => {
        assert.deepEqual(listIdsRaw, ["skill-list-1"]);
        return ["skill-a"];
      },
      resolveImportedSkillPromptSegments: async (_dataRoot: string, skillIds: string[]) => {
        assert.deepEqual(skillIds, ["skill-a"]);
        return { segments: ["skill prompt"] };
      }
    }
  );

  assert.equal(bundle.rolePrompt, "you are dev");
  assert.deepEqual(bundle.skillIds, ["skill-a"]);
  assert.deepEqual(bundle.skillSegments, ["skill prompt"]);
});

test("orchestrator role prompt skill bundle supports trim plus fallback prompt", async () => {
  const bundle = await resolveOrchestratorRolePromptSkillBundle(
    {
      dataRoot: "C:\\memory",
      role: "qa",
      trimRolePrompt: true,
      fallbackRolePrompt: (role) => `fallback:${role}`,
      agents: [{ agentId: "qa", prompt: "   ", skillList: [] }] as any
    },
    {
      listAgents: async () => {
        throw new Error("listAgents should not be called when agents are provided");
      },
      resolveSkillIdsForAgent: async () => [],
      resolveImportedSkillPromptSegments: async () => ({ segments: [] })
    }
  );

  assert.equal(bundle.rolePrompt, "fallback:qa");
  assert.deepEqual(bundle.skillIds, []);
  assert.deepEqual(bundle.skillSegments, []);
});
