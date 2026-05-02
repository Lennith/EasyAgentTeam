import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

test("settings API returns and updates provider settings", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-settings-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const serverHandle = await startTestHttpServer(app);
  const baseUrl = serverHandle.baseUrl;

  try {
    const initialRes = await fetch(`${baseUrl}/api/settings`);
    assert.equal(initialRes.status, 200);
    const initialPayload = (await initialRes.json()) as {
      providers?: { codex?: { cliCommand?: string } };
      hostPlatform?: string;
      supportedShellTypes?: string[];
      defaultShellType?: string;
    };
    assert.equal(typeof initialPayload.providers?.codex?.cliCommand, "string");
    assert.equal((initialPayload.providers?.codex?.cliCommand ?? "").trim().length > 0, true);
    assert.equal(["win32", "linux", "darwin"].includes(initialPayload.hostPlatform ?? ""), true);
    assert.equal(Array.isArray(initialPayload.supportedShellTypes), true);
    assert.equal(typeof initialPayload.defaultShellType, "string");

    const patchRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          codex: {
            cliCommand: "codex"
          }
        }
      })
    });
    assert.equal(patchRes.status, 200);
    const patchPayload = (await patchRes.json()) as {
      providers?: { codex?: { cliCommand?: string } };
      hostPlatform?: string;
    };
    assert.equal(patchPayload.providers?.codex?.cliCommand, "codex");
    assert.equal(["win32", "linux", "darwin"].includes(patchPayload.hostPlatform ?? ""), true);

    const afterRes = await fetch(`${baseUrl}/api/settings`);
    assert.equal(afterRes.status, 200);
    const afterPayload = (await afterRes.json()) as { providers?: { codex?: { cliCommand?: string } } };
    assert.equal(afterPayload.providers?.codex?.cliCommand, "codex");
  } finally {
    await serverHandle.close();
  }
});

test("settings API supports minimax provider clear and reset with null semantics", async () => {
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
        providers: {
          minimax: {
            apiKey: "test_key_1",
            apiBase: "https://api.minimaxi.com/v1"
          }
        }
      })
    });
    assert.equal(setRes.status, 200);
    const setPayload = (await setRes.json()) as { providers?: { minimax?: { apiKey?: string; apiBase?: string } } };
    assert.equal(setPayload.providers?.minimax?.apiKey, "test_key_1");
    assert.equal(setPayload.providers?.minimax?.apiBase, "https://api.minimaxi.com/v1");

    const clearRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          minimax: {
            apiKey: null,
            apiBase: null
          }
        }
      })
    });
    assert.equal(clearRes.status, 200);
    const clearPayload = (await clearRes.json()) as { providers?: { minimax?: { apiKey?: string; apiBase?: string } } };
    assert.equal(clearPayload.providers?.minimax?.apiKey, undefined);
    assert.equal(clearPayload.providers?.minimax?.apiBase, undefined);

    const afterClearRes = await fetch(`${baseUrl}/api/settings`);
    assert.equal(afterClearRes.status, 200);
    const afterClearPayload = (await afterClearRes.json()) as {
      providers?: { minimax?: { apiKey?: string; apiBase?: string } };
    };
    assert.equal(afterClearPayload.providers?.minimax?.apiKey, undefined);
    assert.equal(afterClearPayload.providers?.minimax?.apiBase, undefined);

    const resetRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          minimax: {
            apiKey: "test_key_2",
            apiBase: "https://api.minimaxi.com/v1"
          }
        }
      })
    });
    assert.equal(resetRes.status, 200);
    const resetPayload = (await resetRes.json()) as { providers?: { minimax?: { apiKey?: string; apiBase?: string } } };
    assert.equal(resetPayload.providers?.minimax?.apiKey, "test_key_2");
    assert.equal(resetPayload.providers?.minimax?.apiBase, "https://api.minimaxi.com/v1");

    const partialRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          minimax: {
            apiKey: "test_key_3"
          }
        }
      })
    });
    assert.equal(partialRes.status, 200);
    const partialPayload = (await partialRes.json()) as {
      providers?: { minimax?: { apiKey?: string; apiBase?: string } };
    };
    assert.equal(partialPayload.providers?.minimax?.apiKey, "test_key_3");
    assert.equal(partialPayload.providers?.minimax?.apiBase, "https://api.minimaxi.com/v1");

    const emptyStringClearRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          minimax: {
            apiKey: "",
            apiBase: ""
          }
        }
      })
    });
    assert.equal(emptyStringClearRes.status, 200);
    const emptyStringClearPayload = (await emptyStringClearRes.json()) as {
      providers?: { minimax?: { apiKey?: string; apiBase?: string } };
    };
    assert.equal(emptyStringClearPayload.providers?.minimax?.apiKey, undefined);
    assert.equal(emptyStringClearPayload.providers?.minimax?.apiBase, undefined);
  } finally {
    await serverHandle.close();
  }
});

test("settings API exposes provider profiles without root compatibility fields", async () => {
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

    assert.equal("codexCliCommand" in payload, false);
    assert.equal("minimaxApiKey" in payload, false);
    assert.equal("minimaxApiBase" in payload, false);
    assert.equal("minimaxModel" in payload, false);
    assert.equal(payload.providers?.codex?.cliCommand, "codex-test");
    assert.equal(payload.providers?.codex?.model, "gpt-5.4");
    assert.equal(payload.providers?.codex?.reasoningEffort, "medium");
    assert.equal(payload.providers?.minimax?.apiKey, "provider_key");
    assert.equal(payload.providers?.minimax?.apiBase, "https://provider.example/v1");
    assert.equal(payload.providers?.minimax?.model, "MiniMax-M2.7-High-speed");
    assert.equal(payload.providers?.minimax?.tokenLimit, 12345);
    assert.equal(payload.providers?.minimax?.maxOutputTokens, 6789);

    const retiredPatchRes = await fetch(`${baseUrl}/api/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        minimaxModel: "MiniMax-M2.5-High-speed"
      })
    });
    assert.equal(retiredPatchRes.status, 400);
    const retiredPayload = (await retiredPatchRes.json()) as { error_code?: string };
    assert.equal(retiredPayload.error_code, "SETTINGS_FIELD_RETIRED");

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
