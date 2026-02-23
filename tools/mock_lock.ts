const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const projectId = process.env.PROJECT_ID ?? "demo_lock_step2";
const lockKey = process.env.LOCK_KEY ?? "src/server";

async function postJson(pathname: string, payload: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function parseNdjson(raw: string): any[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function createProjectIfMissing() {
  const response = await postJson("/api/projects", {
    project_id: projectId,
    name: "Demo Lock Step2",
    workspace_path: "D:/AiAgent/AutoDevelopFramework"
  });
  if (response.status === 201) {
    console.log("[mock_lock] project created");
    return;
  }
  if (response.status === 409) {
    console.log("[mock_lock] project already exists");
    return;
  }
  throw new Error(`create project failed: ${response.status} ${JSON.stringify(response.body)}`);
}

async function runFlow() {
  const first = await postJson(`/api/projects/${projectId}/locks/acquire`, {
    session_id: "session-a",
    lock_key: lockKey,
    ttl_seconds: 2,
    purpose: "session-a editing"
  });
  console.log("[mock_lock] acquire session-a:", first.status, first.body);

  const conflict = await postJson(`/api/projects/${projectId}/locks/acquire`, {
    session_id: "session-b",
    lock_key: lockKey,
    ttl_seconds: 2,
    purpose: "session-b editing"
  });
  console.log("[mock_lock] acquire session-b conflict:", conflict.status, conflict.body);

  await new Promise((resolve) => setTimeout(resolve, 2600));

  const steal = await postJson(`/api/projects/${projectId}/locks/acquire`, {
    session_id: "session-b",
    lock_key: lockKey,
    ttl_seconds: 60,
    purpose: "session-b steal after expiry"
  });
  console.log("[mock_lock] acquire session-b after expiry:", steal.status, steal.body);

  const locksResponse = await fetch(`${baseUrl}/api/projects/${projectId}/locks`);
  const locksPayload = await locksResponse.json();
  console.log("[mock_lock] active locks:", locksPayload);

  const eventsResponse = await fetch(`${baseUrl}/api/projects/${projectId}/events`);
  const eventsRaw = await eventsResponse.text();
  const events = parseNdjson(eventsRaw).filter((event) =>
    String(event.eventType ?? "").startsWith("LOCK_")
  );
  console.log("[mock_lock] lock events (latest 5):", events.slice(-5));
}

async function main() {
  await createProjectIfMissing();
  await runFlow();
}

main().catch((error) => {
  console.error("[mock_lock] failed:", error.message);
  process.exitCode = 1;
});

