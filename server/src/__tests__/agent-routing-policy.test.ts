import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import { createServer } from "node:http";
import { createApp } from "../app.js";

function parseNdjson(raw: string): Array<{ eventType: string }> {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { eventType: string });
}

async function seedAgent(baseUrl: string, agentId: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: agentId,
      display_name: agentId,
      prompt: `${agentId} prompt`
    })
  });
  assert.equal(res.status, 201);
}

test("route table denies illegal agent-to-agent message", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-route-policy-"));
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
    for (const agentId of ["PM", "planner"]) {
      await seedAgent(baseUrl, agentId);
    }

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "routepolicy",
        name: "Route Policy",
        workspace_path: tempRoot,
        agent_ids: ["PM", "planner"],
        route_table: {
          PM: ["planner"],
          planner: []
        }
      })
    });
    assert.equal(createRes.status, 201);

    await fetch(`${baseUrl}/api/projects/routepolicy/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-pm", role: "PM" })
    });
    await fetch(`${baseUrl}/api/projects/routepolicy/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "sess-planner", role: "planner" })
    });

    const deniedRes = await fetch(`${baseUrl}/api/projects/routepolicy/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "planner",
        to: { agent: "PM", session_id: null },
        content: "try illegal route",
        mode: "CHAT",
        message_type: "MANAGER_MESSAGE"
      })
    });
    assert.equal(deniedRes.status, 403);

    const allowedRes = await fetch(`${baseUrl}/api/projects/routepolicy/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_agent: "PM",
        to: { agent: "planner", session_id: null },
        content: "legal route",
        mode: "CHAT",
        message_type: "MANAGER_MESSAGE"
      })
    });
    assert.equal(allowedRes.status, 201);

    const eventsRes = await fetch(`${baseUrl}/api/projects/routepolicy/events`);
    assert.equal(eventsRes.status, 200);
    const events = parseNdjson(await eventsRes.text());
    const types = new Set(events.map((event) => event.eventType));
    assert.equal(types.has("MESSAGE_ROUTE_DENIED"), true);
    assert.equal(types.has("MESSAGE_ROUTED"), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("project routing-config API updates directional discuss limits", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "autodev-route-config-"));
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
    for (const agentId of ["PM", "planner"]) {
      await seedAgent(baseUrl, agentId);
    }

    const createRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "routecfg",
        name: "Route Config",
        workspace_path: tempRoot,
        agent_ids: ["PM", "planner"],
        route_table: {
          PM: ["planner"],
          planner: ["PM"]
        },
        route_discuss_rounds: {
          PM: { planner: 2 },
          planner: { PM: 2 }
        }
      })
    });
    assert.equal(createRes.status, 201);

    const patchRes = await fetch(`${baseUrl}/api/projects/routecfg/routing-config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_ids: ["PM", "planner"],
        route_table: {
          PM: ["planner"],
          planner: ["PM"]
        },
        route_discuss_rounds: {
          PM: { planner: 3 },
          planner: { PM: 5 }
        }
      })
    });
    assert.equal(patchRes.status, 200);
    const patchPayload = (await patchRes.json()) as {
      routeDiscussRounds?: Record<string, Record<string, number>>;
    };
    assert.equal(patchPayload.routeDiscussRounds?.PM?.planner, 3);
    assert.equal(patchPayload.routeDiscussRounds?.planner?.PM, 5);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

