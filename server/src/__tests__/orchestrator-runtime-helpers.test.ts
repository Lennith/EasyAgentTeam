import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildOrchestratorAgentProgressFile,
  buildOrchestratorAgentWorkspaceDir,
  buildOrchestratorMinimaxSessionDir,
  resolveOrchestratorManagerUrl,
  resolveOrchestratorProviderSessionId
} from "../services/orchestrator/shared/index.js";

test("orchestrator runtime helpers build stable workspace and session paths", () => {
  const workspaceRoot = path.join("C:", "repo", "workspace");
  assert.equal(
    buildOrchestratorAgentWorkspaceDir(workspaceRoot, "dev_backend"),
    path.join(workspaceRoot, "Agents", "dev_backend")
  );
  assert.equal(
    buildOrchestratorAgentProgressFile(workspaceRoot, "dev_backend"),
    path.join(workspaceRoot, "Agents", "dev_backend", "progress.md")
  );
  assert.equal(buildOrchestratorMinimaxSessionDir(workspaceRoot), path.join(workspaceRoot, ".minimax", "sessions"));
});

test("orchestrator runtime helpers resolve provider session ids with trimmed fallback", () => {
  assert.equal(resolveOrchestratorProviderSessionId("session-dev-001", " provider-dev-001 "), "provider-dev-001");
  assert.equal(resolveOrchestratorProviderSessionId("session-dev-001", "   "), "session-dev-001");
  assert.equal(resolveOrchestratorProviderSessionId("session-dev-001", undefined), "session-dev-001");
});

test("orchestrator runtime helpers keep manager url default and env override stable", () => {
  const previous = process.env.AUTO_DEV_MANAGER_URL;
  try {
    delete process.env.AUTO_DEV_MANAGER_URL;
    assert.equal(resolveOrchestratorManagerUrl(), "http://127.0.0.1:43123");
    process.env.AUTO_DEV_MANAGER_URL = "http://127.0.0.1:50001";
    assert.equal(resolveOrchestratorManagerUrl(), "http://127.0.0.1:50001");
  } finally {
    if (previous === undefined) {
      delete process.env.AUTO_DEV_MANAGER_URL;
    } else {
      process.env.AUTO_DEV_MANAGER_URL = previous;
    }
  }
});
