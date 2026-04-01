import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createApp } from "../app.js";
import { DISCUSS_DEFAULT_MAX_ROUNDS } from "../services/discuss-policy-service.js";
import { startTestHttpServer, type TestHttpServerHandle } from "./helpers/http-test-server.js";

async function startServerWithBaseUrl(app: ReturnType<typeof createApp>): Promise<{
  server: TestHttpServerHandle["server"];
  baseUrl: string;
  close: TestHttpServerHandle["close"];
}> {
  const handle = await startTestHttpServer(app);
  return {
    server: handle.server,
    baseUrl: handle.baseUrl,
    close: handle.close
  };
}

async function seedAgent(baseUrl: string, agentId: string): Promise<void> {
  const seedRes = await fetch(new URL("/api/agents", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      display_name: agentId,
      prompt: `${agentId} prompt`
    })
  });
  assert.equal(seedRes.status, 201);
}

test("route-targets API returns directional targets with directional discuss rounds", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-route-targets-dir-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const { baseUrl, close } = await startServerWithBaseUrl(app);

  try {
    for (const agentId of ["PM", "planner", "devleader"]) {
      await seedAgent(baseUrl, agentId);
    }

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "routetargetsdir",
        name: "Route Targets Directional",
        workspace_path: tempRoot,
        agent_ids: ["PM", "planner", "devleader"],
        route_table: {
          PM: ["planner"],
          planner: ["PM", "devleader"],
          devleader: []
        },
        route_discuss_rounds: {
          planner: { PM: 5, devleader: 2 }
        }
      })
    });
    assert.equal(createRes.status, 201);

    const targetsRes = await fetch(`${baseUrl}/api/projects/routetargetsdir/route-targets?from_agent=planner`);
    assert.equal(targetsRes.status, 200);
    const payload = (await targetsRes.json()) as {
      fromAgent: string;
      fromAgentEnabled: boolean;
      allowedTargets: Array<{ agentId: string; maxDiscussRounds: number }>;
    };
    assert.equal(payload.fromAgent, "planner");
    assert.equal(payload.fromAgentEnabled, true);
    const byRole = new Map(payload.allowedTargets.map((item) => [item.agentId, item.maxDiscussRounds]));
    assert.equal(byRole.get("PM"), 5);
    assert.equal(byRole.get("devleader"), 2);
  } finally {
    await close();
  }
});

test("route-targets API falls back to enabled agents when route table is not configured", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-route-targets-default-"));
  const dataRoot = path.join(tempRoot, "data");
  const app = createApp({ dataRoot });
  const { baseUrl, close } = await startServerWithBaseUrl(app);

  try {
    for (const agentId of ["agent_a", "agent_b", "agent_c"]) {
      await seedAgent(baseUrl, agentId);
    }

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "routetargetsdefault",
        name: "Route Targets Default",
        workspace_path: tempRoot,
        agent_ids: ["agent_a", "agent_b", "agent_c"]
      })
    });
    assert.equal(createRes.status, 201);

    const targetsRes = await fetch(`${baseUrl}/api/projects/routetargetsdefault/route-targets?from_agent=agent_b`);
    assert.equal(targetsRes.status, 200);
    const payload = (await targetsRes.json()) as {
      hasExplicitRouteTable: boolean;
      allowedTargets: Array<{ agentId: string; maxDiscussRounds: number }>;
    };
    assert.equal(payload.hasExplicitRouteTable, false);
    const byRole = new Map(payload.allowedTargets.map((item) => [item.agentId, item.maxDiscussRounds]));
    assert.equal(byRole.get("agent_a"), DISCUSS_DEFAULT_MAX_ROUNDS);
    assert.equal(byRole.get("agent_c"), DISCUSS_DEFAULT_MAX_ROUNDS);
    assert.equal(byRole.has("agent_b"), false);
  } finally {
    await close();
  }
});
