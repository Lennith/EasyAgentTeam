import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

function resolveOrchestratorServicePath(): string {
  const candidates = [
    path.resolve(process.cwd(), "src", "services", "orchestrator-service.ts"),
    path.resolve(process.cwd(), "server", "src", "services", "orchestrator-service.ts")
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    const stat = statSync(candidate);
    if (stat.isFile()) {
      return candidate;
    }
  }
  throw new Error("orchestrator-service.ts not found from current test working directory");
}

test("project dispatch prompt defines focus-task and dependency-ready reporting contract", async () => {
  const source = await fs.readFile(resolveOrchestratorServicePath(), "utf8");
  assert.equal(source.includes("focus_task_id"), true);
  assert.equal(source.includes("this_turn_operate_task_id"), true);
  assert.equal(source.includes("visible_actionable_tasks"), true);
  assert.equal(source.includes("visible_blocked_tasks"), true);
  assert.equal(source.includes("focus_task_dependencies_ready"), true);
  assert.equal(source.includes("non-focus task reporting is allowed only when dependencies are already ready"), true);
  assert.equal(source.includes("never report IN_PROGRESS/DONE/MAY_BE_DONE for dependency-blocked tasks"), true);
});
