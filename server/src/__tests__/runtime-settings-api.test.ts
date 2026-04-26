import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("settings API returns and updates codex cli command", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-settings-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const initialRes = await fetch(`${baseUrl}/api/settings`);
    assert.equal(initialRes.status, 200);
    const initialPayload = (await initialRes.json()) as {
      codexCliCommand?: string;
      hostPlatform?: string;
      supportedShellTypes?: string[];
      defaultShellType?: string;
    };
    assert.equal(typeof initialPayload.codexCliCommand, "string");
    assert.equal((initialPayload.codexCliCommand ?? "").trim().length > 0, true);
    assert.equal(["win32", "linux", "darwin"].includes(initialPayload.hostPlatform ?? ""), true);
    assert.equal(Array.isArray(initialPayload.supportedShellTypes), true);
    assert.equal(typeof initialPayload.defaultShellType, "string");

    const patchRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codex_cli_command: "codex"
      })
    });
    assert.equal(patchRes.status, 200);
    const patchPayload = (await patchRes.json()) as { codexCliCommand?: string; hostPlatform?: string };
    assert.equal(patchPayload.codexCliCommand, "codex");
    assert.equal(["win32", "linux", "darwin"].includes(patchPayload.hostPlatform ?? ""), true);

    const afterRes = await fetch(`${baseUrl}/api/settings`);
    assert.equal(afterRes.status, 200);
    const afterPayload = (await afterRes.json()) as { codexCliCommand?: string };
    assert.equal(afterPayload.codexCliCommand, "codex");
  } finally {
    await serverHandle.close();
  }
});

test("settings API supports minimax clear and reset with null semantics", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-settings-api-minimax-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

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
    await serverHandle.close();
  }
});

test("settings API exposes provider profiles and keeps legacy fields compatible", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-settings-api-provider-profile-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const patchRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          codex: {
            cliCommand: "codex-test",
            model: "gpt-5.4",
            reasoningEffort: "medium"
          },
          minimax: {
            apiKey: "provider_key",
            apiBase: "https://provider.example/v1",
            model: "MiniMax-M2.7-High-speed",
            tokenLimit: 12345,
            maxOutputTokens: 6789
          }
        }
      })
    });
    assert.equal(patchRes.status, 200);
    const payload = (await patchRes.json()) as {
      codexCliCommand?: string;
      minimaxApiKey?: string;
      minimaxApiBase?: string;
      minimaxModel?: string;
      minimaxTokenLimit?: number;
      minimaxMaxOutputTokens?: number;
      providers?: {
        codex?: { cliCommand?: string; model?: string; reasoningEffort?: string };
        minimax?: {
          apiKey?: string;
          apiBase?: string;
          model?: string;
          tokenLimit?: number;
          maxOutputTokens?: number;
        };
      };
    };

    assert.equal(payload.codexCliCommand, "codex-test");
    assert.equal(payload.minimaxApiKey, "provider_key");
    assert.equal(payload.minimaxApiBase, "https://provider.example/v1");
    assert.equal(payload.minimaxModel, "MiniMax-M2.7-High-speed");
    assert.equal(payload.minimaxTokenLimit, 12345);
    assert.equal(payload.minimaxMaxOutputTokens, 6789);
    assert.equal(payload.providers?.codex?.cliCommand, "codex-test");
    assert.equal(payload.providers?.codex?.model, "gpt-5.4");
    assert.equal(payload.providers?.codex?.reasoningEffort, "medium");
    assert.equal(payload.providers?.minimax?.apiKey, "provider_key");
    assert.equal(payload.providers?.minimax?.apiBase, "https://provider.example/v1");
    assert.equal(payload.providers?.minimax?.model, "MiniMax-M2.7-High-speed");
    assert.equal(payload.providers?.minimax?.tokenLimit, 12345);
    assert.equal(payload.providers?.minimax?.maxOutputTokens, 6789);

    const legacyPatchRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        minimaxModel: "MiniMax-M2.5-High-speed"
      })
    });
    assert.equal(legacyPatchRes.status, 200);
    const legacyPayload = (await legacyPatchRes.json()) as {
      minimaxModel?: string;
      providers?: { minimax?: { model?: string } };
    };
    assert.equal(legacyPayload.minimaxModel, "MiniMax-M2.5-High-speed");
    assert.equal(legacyPayload.providers?.minimax?.model, "MiniMax-M2.5-High-speed");

    const codexPartialPatchRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          codex: {
            cliCommand: "codex-partial"
          }
        }
      })
    });
    assert.equal(codexPartialPatchRes.status, 200);
    const codexPartialPayload = (await codexPartialPatchRes.json()) as {
      providers?: { codex?: { cliCommand?: string; model?: string; reasoningEffort?: string } };
    };
    assert.equal(codexPartialPayload.providers?.codex?.cliCommand, "codex-partial");
    assert.equal(codexPartialPayload.providers?.codex?.model, "gpt-5.4");
    assert.equal(codexPartialPayload.providers?.codex?.reasoningEffort, "medium");
  } finally {
    await serverHandle.close();
  }
});
