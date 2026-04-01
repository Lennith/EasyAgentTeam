import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildOrchestratorToolSessionInput } from "../services/orchestrator/shared/index.js";

test("orchestrator tool session input builder applies provider session and minimax dir fallbacks", () => {
  const workspaceRoot = path.join("D:", "AgentWorkspace", "Workflow1");
  const built = buildOrchestratorToolSessionInput({
    prompt: "continue",
    sessionId: "session-dev-001",
    workspaceDir: path.join(workspaceRoot, "Agents", "dev"),
    workspaceRoot,
    role: "dev",
    contextKind: "workflow_dispatch",
    runtimeConstraints: ["Report DONE via TASK_REPORT."],
    apiBaseFallback: "https://api.minimax.io",
    modelFallback: "MiniMax-M2.5-High-speed"
  });

  assert.equal(built.providerSessionId, "session-dev-001");
  assert.equal(built.sessionDirFallback, path.join(workspaceRoot, ".minimax", "sessions"));
  assert.deepEqual(built.runtimeConstraints, ["Report DONE via TASK_REPORT."]);
});

test("orchestrator tool session input builder preserves explicit overrides and optional fields", () => {
  const built = buildOrchestratorToolSessionInput(
    {
      prompt: "reply",
      sessionId: "session-qa-001",
      providerSessionId: " provider-qa-001 ",
      workspaceDir: "C:\\workspace\\Agents\\qa",
      workspaceRoot: "C:\\workspace",
      role: "qa",
      rolePrompt: "You are QA.",
      skillSegments: ["skill prompt"],
      skillIds: ["skill-1"],
      contextKind: "workflow_agent_chat",
      contextOverride: "Focus on bug reproduction",
      runtimeConstraints: ["Use task tools."],
      sessionDirFallback: "C:\\custom\\.minimax\\sessions",
      apiBaseFallback: "https://api.minimax.io/v1",
      modelFallback: "MiniMax-Text-01",
      env: { AUTO_DEV_AGENT_ROLE: "qa" }
    },
    {
      callback: {
        onMessage: () => {}
      }
    }
  );

  assert.equal(built.providerSessionId, "provider-qa-001");
  assert.equal(built.sessionDirFallback, "C:\\custom\\.minimax\\sessions");
  assert.equal(built.rolePrompt, "You are QA.");
  assert.deepEqual(built.skillIds, ["skill-1"]);
  assert.deepEqual(built.skillSegments, ["skill prompt"]);
  assert.equal(built.contextOverride, "Focus on bug reproduction");
  assert.deepEqual(built.env, { AUTO_DEV_AGENT_ROLE: "qa" });
  assert.equal(typeof built.callback?.onMessage, "function");
});
