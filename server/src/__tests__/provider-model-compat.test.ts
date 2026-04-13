import assert from "node:assert/strict";
import test from "node:test";
import { ProviderLaunchError, normalizeCodexLaunchFailure } from "../services/provider-launch-error.js";
import { validateProviderModelCompatibility } from "../services/provider-model-compat.js";

test("provider model compatibility rejects MiniMax model for codex and accepts gpt-5.3-codex", () => {
  const rejected = validateProviderModelCompatibility({
    providerId: "codex",
    model: "MiniMax-M2.5"
  });
  assert.equal(rejected.ok, false);
  if (rejected.ok) {
    return;
  }
  assert.equal(rejected.code, "PROVIDER_MODEL_MISMATCH");

  const accepted = validateProviderModelCompatibility({
    providerId: "codex",
    model: "gpt-5.3-codex"
  });
  assert.deepEqual(accepted, { ok: true });
});

test("codex launch failure normalizer converts unsupported model output into provider launch error", () => {
  const normalized = normalizeCodexLaunchFailure({
    model: "MiniMax-M2.5",
    stderr: "Error: Unknown model 'MiniMax-M2.5' when using Codex CLI",
    command: "codex"
  });

  assert.equal(normalized instanceof ProviderLaunchError, true);
  assert.equal(normalized?.code, "PROVIDER_MODEL_MISMATCH");
  assert.equal(normalized?.category, "config");
});
