import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createAgent, deleteAgent, listAgents, patchAgent } from "../data/repository/catalog/agent-repository.js";

test("agent registry is empty by default (built-ins are templates only)", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-agent-seed-"));
  const dataRoot = path.join(tempRoot, "data");
  const agents = await listAgents(dataRoot);
  assert.equal(agents.length, 0);
});

test("agent registry supports create/edit/delete lifecycle", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-agent-crud-"));
  const dataRoot = path.join(tempRoot, "data");

  const created = await createAgent(dataRoot, {
    agentId: "pm-custom",
    displayName: "PM Custom",
    prompt: "draft requirements"
  });
  assert.equal(created.agentId, "pm-custom");

  const updated = await patchAgent(dataRoot, "pm-custom", {
    displayName: "PM Custom v2",
    prompt: "draft requirements and handoff"
  });
  assert.equal(updated.displayName, "PM Custom v2");
  assert.equal(updated.prompt, "draft requirements and handoff");

  const removed = await deleteAgent(dataRoot, "pm-custom");
  assert.equal(removed.agentId, "pm-custom");

  const agents = await listAgents(dataRoot);
  assert.equal(agents.length, 0);
});
