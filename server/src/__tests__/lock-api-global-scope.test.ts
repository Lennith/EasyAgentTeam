import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("locks conflict across projects sharing the same workspace", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-lock-api-global-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const createA = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "lockscopea",
        name: "Lock Scope A",
        workspace_path: workspaceRoot
      })
    });
    assert.equal(createA.status, 201);

    const createB = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "lockscopeb",
        name: "Lock Scope B",
        workspace_path: workspaceRoot
      })
    });
    assert.equal(createB.status, 201);

    const acquireA = await fetch(`${baseUrl}/api/projects/lockscopea/locks/acquire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "session-a",
        lock_key: "src/file-a.ts",
        target_type: "file",
        ttl_seconds: 120
      })
    });
    assert.equal(acquireA.status, 201);

    const acquireB = await fetch(`${baseUrl}/api/projects/lockscopeb/locks/acquire`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: "session-b",
        lock_key: "src",
        target_type: "dir",
        ttl_seconds: 120
      })
    });
    assert.equal(acquireB.status, 409);
    const failed = (await acquireB.json()) as { existingLock?: { ownerDomainId?: string } };
    assert.equal(failed.existingLock?.ownerDomainId, "lockscopea");

    const listB = await fetch(`${baseUrl}/api/projects/lockscopeb/locks`);
    assert.equal(listB.status, 200);
    const payload = (await listB.json()) as {
      items: Array<{ ownerDomain?: string; ownerDomainId?: string; lockKey?: string }>;
      total: number;
    };
    assert.equal(payload.total, 1);
    assert.equal(payload.items[0].ownerDomain, "project");
    assert.equal(payload.items[0].ownerDomainId, "lockscopea");
    assert.equal(payload.items[0].lockKey, "src/file-a.ts");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
