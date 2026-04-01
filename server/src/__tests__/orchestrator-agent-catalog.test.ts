import assert from "node:assert/strict";
import test from "node:test";
import { buildOrchestratorAgentCatalog } from "../services/orchestrator/shared/orchestrator-agent-catalog.js";

test("orchestrator agent catalog builds shared ids and role maps", () => {
  const catalog = buildOrchestratorAgentCatalog([
    { agentId: "dev", prompt: "You build", summary: "builder" },
    { agentId: "qa", prompt: "You test" }
  ]);

  assert.deepEqual(catalog.agentIds, ["dev", "qa"]);
  assert.equal(catalog.rolePromptMap.get("dev"), "You build");
  assert.equal(catalog.rolePromptMap.get("qa"), "You test");
  assert.equal(catalog.roleSummaryMap.get("dev"), "builder");
  assert.equal(catalog.roleSummaryMap.get("qa"), "");
});
