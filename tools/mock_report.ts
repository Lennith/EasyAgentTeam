const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const projectId = process.env.PROJECT_ID ?? "demo_step1";

async function createProjectIfMissing(): Promise<void> {
  const payload = {
    project_id: projectId,
    name: "Demo Step1",
    workspace_path: "D:/AiAgent/AutoDevelopFramework"
  };

  const response = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (response.status === 201) {
    console.log("[mock_report] project created");
    return;
  }

  if (response.status === 409) {
    console.log("[mock_report] project already exists");
    return;
  }

  const text = await response.text();
  throw new Error(`create project failed: HTTP ${response.status} ${text}`);
}

async function postMockReport(): Promise<void> {
  const reportPayload = {
    schemaVersion: "1.0",
    report_id: `report-${Date.now()}`,
    project_id: projectId,
    session_id: "session-alpha",
    agent_id: "agent-alpha",
    task_id: "task-step1",
    status: "HANDOFF",
    summary: "handoff mock report from tools script",
    created_at: new Date().toISOString(),
    next_actions: [
      {
        target_session_id: "session-beta",
        to_agent_id: "agent-beta",
        type: "ASSIGN_TASK",
        payload: {
          instruction: "continue task-step1"
        }
      }
    ],
    manager_requests: [
      {
        type: "RELEASE_LOCKS"
      }
    ]
  };

  const response = await fetch(`${baseUrl}/api/projects/${projectId}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reportPayload)
  });

  if (response.status !== 201) {
    const text = await response.text();
    throw new Error(`post report failed: HTTP ${response.status} ${text}`);
  }

  const payload = await response.json();
  console.log("[mock_report] report submitted:", payload);
}

function parseNdjson(raw: string): unknown[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function printLatestEvents(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/events`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`read events failed: HTTP ${response.status} ${text}`);
  }
  const raw = await response.text();
  const events = parseNdjson(raw);
  console.log(`[mock_report] total events: ${events.length}`);
  console.log("[mock_report] latest events:", events.slice(-3));
}

async function printInboxSessions(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`read project detail failed: HTTP ${response.status} ${text}`);
  }
  const payload = await response.json();
  console.log("[mock_report] inbox sessions:", payload.inboxSessions ?? []);
}

async function main() {
  await createProjectIfMissing();
  await postMockReport();
  await printLatestEvents();
  await printInboxSessions();
}

main().catch((error) => {
  console.error("[mock_report] failed:", error.message);
  process.exitCode = 1;
});

