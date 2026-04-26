import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveMiniMaxRuntimeModel } from "../services/provider-runtime.js";
import type { RuntimeSettings } from "../data/repository/system/runtime-settings-repository.js";

function settingsWithProfile(model: string | undefined): RuntimeSettings {
  return {
    schemaVersion: "1.0",
    updatedAt: new Date().toISOString(),
    codexCliCommand: "codex",
    minimaxModel: model,
    providers: {
      codex: {
        cliCommand: "codex"
      },
      minimax: {
        model
      }
    }
  };
}

test("MiniMax runtime model selection prefers explicit run model over provider profile", () => {
  assert.equal(
    resolveMiniMaxRuntimeModel(settingsWithProfile("MiniMax-Profile"), {
      model: "MiniMax-Run",
      modelFallback: "MiniMax-Hardcoded"
    }),
    "MiniMax-Run"
  );
});

test("MiniMax runtime model selection prefers provider profile over hardcoded fallback", () => {
  assert.equal(
    resolveMiniMaxRuntimeModel(settingsWithProfile("MiniMax-Profile"), {
      modelFallback: "MiniMax-Hardcoded"
    }),
    "MiniMax-Profile"
  );
});
