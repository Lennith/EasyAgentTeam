import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("skills and skill-lists APIs support import/CRUD and agent references", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-skills-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const sourceRoot = path.join(tempRoot, "source-skills");
  const skillDir = path.join(sourceRoot, "minimax-vision");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "# MiniMax Vision\n\nAnalyze screenshots for UI issues.\n",
    "utf8"
  );
  await fs.mkdir(path.join(skillDir, "assets"), { recursive: true });
  await fs.writeFile(path.join(skillDir, "assets", "model.bin"), "binary", "utf8");

  const app = createApp({ dataRoot });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const importRes = await fetch(`${baseUrl}/api/skills/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sources: [sourceRoot], recursive: true })
    });
    assert.equal(importRes.status, 200);
    const importPayload = (await importRes.json()) as {
      imported: Array<{ skill: { skillId: string } }>;
      warnings: string[];
    };
    assert.equal(importPayload.imported.length, 1);
    const skillId = importPayload.imported[0]?.skill.skillId ?? "";
    assert.equal(skillId.length > 0, true);
    assert.equal(importPayload.warnings.length > 0, true);

    const listSkillsRes = await fetch(`${baseUrl}/api/skills`);
    assert.equal(listSkillsRes.status, 200);
    const listSkillsPayload = (await listSkillsRes.json()) as { items: Array<{ skillId: string }>; total: number };
    assert.equal(listSkillsPayload.total, 1);
    assert.equal(listSkillsPayload.items[0]?.skillId, skillId);

    const createListRes = await fetch(`${baseUrl}/api/skill-lists`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        list_id: "default-core",
        display_name: "Default Core",
        include_all: false,
        skill_ids: [skillId]
      })
    });
    assert.equal(createListRes.status, 201);

    const invalidListRes = await fetch(`${baseUrl}/api/skill-lists`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        list_id: "invalid-ref",
        skill_ids: ["missing-skill-id"]
      })
    });
    assert.equal(invalidListRes.status, 400);

    const createAgentRes = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "dev_1",
        display_name: "Dev 1",
        prompt: "Build backend service",
        summary: "Backend implementer",
        skill_list: ["default-core"]
      })
    });
    assert.equal(createAgentRes.status, 201);
    const createdAgent = (await createAgentRes.json()) as { summary?: string; skill_list?: string[] };
    assert.equal(createdAgent.summary, "Backend implementer");
    assert.deepEqual(createdAgent.skill_list, ["default-core"]);

    const invalidAgentRes = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "dev_2",
        display_name: "Dev 2",
        prompt: "Build frontend service",
        skill_list: ["missing-list"]
      })
    });
    assert.equal(invalidAgentRes.status, 400);

    const agentsRes = await fetch(`${baseUrl}/api/agents`);
    assert.equal(agentsRes.status, 200);
    const agentsPayload = (await agentsRes.json()) as {
      items: Array<{ agentId: string; summary?: string; skill_list?: string[] }>;
    };
    const devAgent = agentsPayload.items.find((item) => item.agentId === "dev_1");
    assert.equal(devAgent?.summary, "Backend implementer");
    assert.deepEqual(devAgent?.skill_list, ["default-core"]);

    const deleteInUseListRes = await fetch(`${baseUrl}/api/skill-lists/default-core`, {
      method: "DELETE"
    });
    assert.equal(deleteInUseListRes.status, 409);

    const patchAgentRes = await fetch(`${baseUrl}/api/agents/dev_1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_list: [], summary: null })
    });
    assert.equal(patchAgentRes.status, 200);

    const deleteListRes = await fetch(`${baseUrl}/api/skill-lists/default-core`, {
      method: "DELETE"
    });
    assert.equal(deleteListRes.status, 200);

    const deleteSkillRes = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(skillId)}`, {
      method: "DELETE"
    });
    assert.equal(deleteSkillRes.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
