import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

test("settings API returns and updates codex cli command", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-settings-api-"));
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
    const initialRes = await fetch(`${baseUrl}/api/settings`);
    assert.equal(initialRes.status, 200);
    const initialPayload = (await initialRes.json()) as { codexCliCommand?: string };
    assert.equal(typeof initialPayload.codexCliCommand, "string");
    assert.equal((initialPayload.codexCliCommand ?? "").trim().length > 0, true);

    const patchRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codex_cli_command: "codex"
      })
    });
    assert.equal(patchRes.status, 200);
    const patchPayload = (await patchRes.json()) as { codexCliCommand?: string };
    assert.equal(patchPayload.codexCliCommand, "codex");

    const afterRes = await fetch(`${baseUrl}/api/settings`);
    assert.equal(afterRes.status, 200);
    const afterPayload = (await afterRes.json()) as { codexCliCommand?: string };
    assert.equal(afterPayload.codexCliCommand, "codex");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
