import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("agent-template API supports built-ins and custom template CRUD", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-agent-template-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const initialRes = await fetch(`${baseUrl}/api/agent-templates`);
    assert.equal(initialRes.status, 200);
    const initialPayload = (await initialRes.json()) as {
      builtInItems: Array<{ templateId: string }>;
      customItems: Array<{ templateId: string }>;
    };
    const builtInIds = new Set(initialPayload.builtInItems.map((item) => item.templateId));
    assert.equal(builtInIds.has("PM"), true);
    assert.equal(builtInIds.has("planner"), true);
    assert.equal(builtInIds.has("planer"), false);
    assert.equal(initialPayload.customItems.length, 0);

    const createRes = await fetch(`${baseUrl}/api/agent-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        template_id: "planner_custom",
        display_name: "Planner Custom",
        prompt: "custom planning prompt",
        based_on_template_id: "planner"
      })
    });
    assert.equal(createRes.status, 201);

    const patchRes = await fetch(`${baseUrl}/api/agent-templates/planner_custom`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        display_name: "Planner Custom V2",
        prompt: "custom planning prompt v2"
      })
    });
    assert.equal(patchRes.status, 200);
    const patchPayload = (await patchRes.json()) as { displayName: string; prompt: string };
    assert.equal(patchPayload.displayName, "Planner Custom V2");
    assert.equal(patchPayload.prompt, "custom planning prompt v2");

    const listRes = await fetch(`${baseUrl}/api/agent-templates`);
    assert.equal(listRes.status, 200);
    const listPayload = (await listRes.json()) as {
      customItems: Array<{ templateId: string; basedOnTemplateId?: string | null }>;
    };
    const custom = listPayload.customItems.find((item) => item.templateId === "planner_custom");
    assert.ok(custom);
    assert.equal(custom?.basedOnTemplateId, "planner");

    const deleteRes = await fetch(`${baseUrl}/api/agent-templates/planner_custom`, {
      method: "DELETE"
    });
    assert.equal(deleteRes.status, 200);
  } finally {
    await serverHandle.close();
  }
});
