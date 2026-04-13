import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { startTestHttpServer } from "./helpers/http-test-server.js";

const fetch = globalThis.fetch;

test("agent, team, and project create reject provider/model mismatch", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-provider-model-api-create-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

  try {
    const createAgent = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "codex_bad_model",
        prompt: "invalid config",
        provider_id: "codex",
        default_model_params: {
          model: "MiniMax-M2.5"
        }
      })
    });
    assert.equal(createAgent.status, 400);
    const agentPayload = (await createAgent.json()) as { error_code?: string; next_action?: string | null };
    assert.equal(agentPayload.error_code, "AGENT_MODEL_PROVIDER_MISMATCH");
    assert.equal(typeof agentPayload.next_action, "string");

    const createTeam = await fetch(`${baseUrl}/api/teams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        team_id: "team_bad_model",
        agent_model_configs: {
          lead: {
            provider_id: "codex",
            model: "MiniMax-M2.5"
          }
        }
      })
    });
    assert.equal(createTeam.status, 400);

    const createProject = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "project_bad_model",
        name: "Project Bad Model",
        workspace_path: workspaceRoot,
        agent_model_configs: {
          lead: {
            provider_id: "codex",
            model: "MiniMax-M2.5"
          }
        }
      })
    });
    assert.equal(createProject.status, 400);
  } finally {
    await server.close();
  }
});

test("agent and project patch reject provider/model mismatch", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-provider-model-api-patch-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const app = createApp({ dataRoot });
  const server = await startTestHttpServer(app);
  const baseUrl = server.baseUrl;

  try {
    const createAgent = await fetch(`${baseUrl}/api/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: "lead",
        prompt: "valid prompt"
      })
    });
    assert.equal(createAgent.status, 201);

    const patchAgent = await fetch(`${baseUrl}/api/agents/lead`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        default_model_params: {
          model: "gpt-5.3-codex"
        }
      })
    });
    assert.equal(patchAgent.status, 400);

    const createProject = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "project_patch_bad_model",
        name: "Project Patch Bad Model",
        workspace_path: workspaceRoot,
        agent_ids: ["lead"]
      })
    });
    assert.equal(createProject.status, 201);

    const patchProject = await fetch(`${baseUrl}/api/projects/project_patch_bad_model/routing-config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_ids: ["lead"],
        route_table: { lead: [] },
        agent_model_configs: {
          lead: {
            provider_id: "codex",
            model: "MiniMax-M2.5"
          }
        }
      })
    });
    assert.equal(patchProject.status, 400);
  } finally {
    await server.close();
  }
});
