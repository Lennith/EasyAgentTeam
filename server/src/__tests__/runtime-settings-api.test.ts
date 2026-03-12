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

test("settings API supports minimax clear and reset with null semantics", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-settings-api-minimax-"));
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
    const setRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        minimaxApiKey: "test_key_1",
        minimaxApiBase: "https://api.minimaxi.com/v1"
      })
    });
    assert.equal(setRes.status, 200);
    const setPayload = (await setRes.json()) as { minimaxApiKey?: string; minimaxApiBase?: string };
    assert.equal(setPayload.minimaxApiKey, "test_key_1");
    assert.equal(setPayload.minimaxApiBase, "https://api.minimaxi.com/v1");

    const clearRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        minimaxApiKey: null,
        minimaxApiBase: null
      })
    });
    assert.equal(clearRes.status, 200);
    const clearPayload = (await clearRes.json()) as { minimaxApiKey?: string; minimaxApiBase?: string };
    assert.equal(clearPayload.minimaxApiKey, undefined);
    assert.equal(clearPayload.minimaxApiBase, undefined);

    const afterClearRes = await fetch(`${baseUrl}/api/settings`);
    assert.equal(afterClearRes.status, 200);
    const afterClearPayload = (await afterClearRes.json()) as { minimaxApiKey?: string; minimaxApiBase?: string };
    assert.equal(afterClearPayload.minimaxApiKey, undefined);
    assert.equal(afterClearPayload.minimaxApiBase, undefined);

    const resetRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        minimaxApiKey: "test_key_2",
        minimaxApiBase: "https://api.minimaxi.com/v1"
      })
    });
    assert.equal(resetRes.status, 200);
    const resetPayload = (await resetRes.json()) as { minimaxApiKey?: string; minimaxApiBase?: string };
    assert.equal(resetPayload.minimaxApiKey, "test_key_2");
    assert.equal(resetPayload.minimaxApiBase, "https://api.minimaxi.com/v1");

    const partialRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        minimaxApiKey: "test_key_3"
      })
    });
    assert.equal(partialRes.status, 200);
    const partialPayload = (await partialRes.json()) as { minimaxApiKey?: string; minimaxApiBase?: string };
    assert.equal(partialPayload.minimaxApiKey, "test_key_3");
    assert.equal(partialPayload.minimaxApiBase, "https://api.minimaxi.com/v1");

    const emptyStringClearRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        minimaxApiKey: "",
        minimaxApiBase: ""
      })
    });
    assert.equal(emptyStringClearRes.status, 200);
    const emptyStringClearPayload = (await emptyStringClearRes.json()) as {
      minimaxApiKey?: string;
      minimaxApiBase?: string;
    };
    assert.equal(emptyStringClearPayload.minimaxApiKey, undefined);
    assert.equal(emptyStringClearPayload.minimaxApiBase, undefined);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
