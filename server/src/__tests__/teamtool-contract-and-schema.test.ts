import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildCodexTeamToolAlias, buildRouteTargetsGuidance } from "../services/teamtool-contract.js";
import { BASE_PROMPT_TEXT } from "../services/agent-prompt-service.js";
import { buildTeamToolInputSchema } from "../services/teamtool-schema.js";

test("Codex TeamTool aliases use teamtool MCP namespace", () => {
  assert.equal(buildCodexTeamToolAlias("route_targets_get"), "mcp__teamtool__route_targets_get");
  assert.equal(
    buildRouteTargetsGuidance("choose an allowed target role, and retry TASK_CREATE once."),
    "Call `route_targets_get` (Codex MCP alias: `mcp__teamtool__route_targets_get`) first, choose an allowed target role, and retry TASK_CREATE once."
  );
});

test("TeamTool schema builder preserves object properties and array|string unions", () => {
  const schema = buildTeamToolInputSchema({
    type: "object",
    properties: {
      title: { type: "string", description: "Task title." },
      to_role: { type: "string", description: "Target role." },
      dependencies: { type: ["array", "string"], description: "Dependency task ids." },
      priority: { type: "number", description: "Priority." }
    },
    required: ["title", "to_role"]
  });

  const parsedArray = schema.parse({
    title: "Implement feature",
    to_role: "dev_agent",
    dependencies: ["task-a", "task-b"],
    priority: 1
  }) as { dependencies: string[] };
  assert.deepEqual(parsedArray.dependencies, ["task-a", "task-b"]);

  const parsedString = schema.parse({
    title: "Implement feature",
    to_role: "dev_agent",
    dependencies: "task-a"
  }) as { dependencies: string };
  assert.equal(parsedString.dependencies, "task-a");

  assert.throws(() => schema.parse({ to_role: "dev_agent" }));
});

test("TeamTool prompt and docs use next_action without hint wording", () => {
  const teamToolDoc = fs.readFileSync(
    path.resolve(process.cwd(), "..", "docs", "spec", "server", "teamtool.spec.md"),
    "utf8"
  );
  assert.equal(BASE_PROMPT_TEXT.includes("hint"), false);
  assert.equal(BASE_PROMPT_TEXT.includes("next_action"), true);
  assert.equal(teamToolDoc.includes("hint"), false);
  assert.equal(teamToolDoc.includes("next_action"), true);
});
