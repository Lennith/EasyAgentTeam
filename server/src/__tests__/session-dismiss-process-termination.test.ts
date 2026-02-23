import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("dismiss returns processTermination result", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-session-dismiss-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to start test server");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const projectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "dismiss-process",
        name: "Dismiss Process",
        workspace_path: tempRoot
      })
    });
    assert.equal(projectRes.status, 201);

    const sessionRes = await fetch(`${baseUrl}/api/projects/dismiss-process/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-a", role: "dev_impl", status: "running" })
    });
    assert.equal([200, 201].includes(sessionRes.status), true);

    const dismissRes = await fetch(`${baseUrl}/api/projects/dismiss-process/sessions/sess-a/dismiss`, {
      method: "POST"
    });
    assert.equal(dismissRes.status, 200);
    const payload = (await dismissRes.json()) as {
      processTermination?: {
        attempted: boolean;
        result: string;
      };
      session: { status: string };
    };
    assert.equal(payload.session.status, "dismissed");
    assert.equal(typeof payload.processTermination?.attempted, "boolean");
    assert.equal(typeof payload.processTermination?.result, "string");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
