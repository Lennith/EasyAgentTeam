import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("/api/projects skips broken project directories", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-project-list-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "healthyproj",
        name: "Healthy Project",
        workspace_path: tempRoot
      })
    });
    assert.equal(createRes.status, 201);

    const brokenDir = path.join(dataRoot, "projects", "Test");
    const invalidDir = path.join(dataRoot, "projects", "bad name");
    await fs.mkdir(path.join(brokenDir, "collab"), { recursive: true });
    await fs.mkdir(path.join(invalidDir, "collab"), { recursive: true });

    const listRes = await fetch(`${baseUrl}/api/projects`);
    assert.equal(listRes.status, 200);
    const payload = (await listRes.json()) as { items: Array<{ projectId: string }>; total: number };
    const ids = payload.items.map((item) => item.projectId);
    assert.equal(ids.includes("healthyproj"), true);
    assert.equal(ids.includes("Test"), false);
  } finally {
    await serverHandle.close();
  }
});
