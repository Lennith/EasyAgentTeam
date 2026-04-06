import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareProjectDispatchLaunch } from "../services/orchestrator/project/project-dispatch-launch-preparation.js";
import { writeOrchestratorPromptArtifact } from "../services/orchestrator/shared/prompt-artifact-writer.js";

test("project dispatch launch preparation resolves model config and writes prompt artifact", async () => {
  const promptDir = await mkdtemp(path.join(os.tmpdir(), "autodev-project-dispatch-prompt-"));
  const ensured: string[] = [];

  const prepared = await prepareProjectDispatchLaunch(
    {
      dataRoot: "C:\\memory",
      project: {
        projectId: "project-1",
        workspacePath: "D:\\AgentWorkSpace\\Project1",
        agentModelConfigs: {
          dev: {
            provider_id: "trae",
            model: "gpt-test",
            effort: "high"
          }
        }
      } as any,
      paths: {
        promptsDir: promptDir
      } as any,
      session: {
        sessionId: "session-1",
        role: "dev"
      } as any,
      providerId: "trae",
      taskId: "task-1",
      messages: [] as any,
      allTasks: [] as any,
      rolePromptMap: new Map([["dev", "prompt"]]),
      roleSummaryMap: new Map([["dev", "summary"]]),
      registeredAgentIds: ["dev", "qa"],
      startedAt: "2026-03-28T12:00:00.000Z",
      dispatchId: "dispatch-1"
    },
    {
      getRuntimeSettings: async () =>
        ({
          traeCliCommand: "trae-cli",
          codexCliCommand: "codex-cli"
        }) as any,
      ensureProjectAgentScripts: async () => {
        ensured.push("scripts");
      },
      ensureAgentWorkspaces: async () => {
        ensured.push("workspaces");
        return { created: [], updated: [] } as any;
      },
      ensureRolePromptFile: async () => {
        ensured.push("rolePrompt");
      },
      buildProjectRoutingSnapshot: () =>
        ({
          projectId: "project-1",
          fromAgent: "dev",
          fromAgentEnabled: true,
          enabledAgents: ["dev", "qa"],
          hasExplicitRouteTable: false,
          allowedTargets: []
        }) as any,
      buildProjectDispatchPromptContext: () => ({ kind: "prompt-context" }) as any,
      buildProjectDispatchPrompt: (context: unknown) => {
        assert.deepEqual(context, { kind: "prompt-context" });
        return "prepared prompt";
      },
      writeOrchestratorPromptArtifact
    }
  );

  assert.deepEqual(ensured, ["scripts", "workspaces", "rolePrompt"]);
  assert.equal(prepared.modelCommand, "trae-cli");
  assert.deepEqual(prepared.modelParams, {
    model: "gpt-test",
    "reasoning-effort": "high"
  });
  assert.match(prepared.promptArtifactPath, /session-1_dispatch-1\.md$/);
  assert.equal(await readFile(prepared.promptArtifactPath, "utf8"), "prepared prompt");
});
