const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const projectId = process.env.PROJECT_ID ?? `demo_workflow_${Date.now()}`;
const workspacePath = process.env.WORKSPACE_PATH ?? "D:/AiAgent/AutoDevelopFramework";

interface HttpResult<T = unknown> {
  status: number;
  body: T;
}

interface TaskRecord {
  taskId: string;
  title: string;
  ownerRole: string;
  ownerSession?: string;
  state: string;
}

function parseNdjson(raw: string): any[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function postJson(pathname: string, payload: unknown): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  } else {
    body = null;
  }
  return { status: response.status, body };
}

async function getJson<T = unknown>(pathname: string): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GET ${pathname} failed: HTTP ${response.status} ${text}`);
  }
  return (await response.json()) as T;
}

async function getText(pathname: string): Promise<string> {
  const response = await fetch(`${baseUrl}${pathname}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GET ${pathname} failed: HTTP ${response.status} ${text}`);
  }
  return response.text();
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function createProjectIfMissing(): Promise<void> {
  const result = await postJson("/api/projects", {
    project_id: projectId,
    name: "Demo Workflow Step3",
    workspace_path: workspacePath,
    role_session_map: {
      dev: "session-dev",
      qa: "session-qa"
    }
  });
  if (result.status === 201) {
    console.log("[mock_workflow] project created");
    return;
  }
  if (result.status === 409) {
    console.log("[mock_workflow] project already exists");
    return;
  }
  throw new Error(`create project failed: ${result.status} ${JSON.stringify(result.body)}`);
}

async function createOrKeepInitialTask(): Promise<void> {
  const result = await postJson(`/api/projects/${projectId}/tasks`, {
    task_id: "task-dev-1",
    title: "Implement feature A",
    owner_role: "dev",
    owner_session: "session-dev",
    state: "DOING",
    write_set: ["src/server", "src/ui"],
    dependencies: [],
    acceptance: ["unit tests pass", "review passed"],
    artifacts: []
  });
  if (result.status === 201) {
    console.log("[mock_workflow] initial dev task created");
    return;
  }
  if (result.status === 409) {
    console.log("[mock_workflow] initial dev task already exists");
    return;
  }
  throw new Error(`create task failed: ${result.status} ${JSON.stringify(result.body)}`);
}

async function submitHandoffReport(): Promise<void> {
  const result = await postJson(`/api/projects/${projectId}/reports`, {
    schemaVersion: "1.0",
    report_id: `workflow-report-${Date.now()}`,
    project_id: projectId,
    session_id: "session-dev",
    agent_id: "agent-dev",
    task_id: "task-dev-1",
    status: "HANDOFF",
    summary: "Dev finished implementation, handoff to QA",
    created_at: new Date().toISOString(),
    next_actions: [
      {
        to_role: "qa",
        task_id: "task-qa-1",
        title: "QA verify feature A",
        write_set: ["tests/e2e"],
        dependencies: ["task-dev-1"],
        acceptance: ["manual verification done", "e2e smoke pass"],
        artifacts: ["qa-report.md"],
        type: "ASSIGN_TASK",
        payload: {
          note: "Please validate feature A from latest commit"
        }
      }
    ],
    manager_requests: []
  });

  if (result.status !== 201) {
    throw new Error(`submit report failed: ${result.status} ${JSON.stringify(result.body)}`);
  }
  console.log("[mock_workflow] report submitted:", result.body);
}

async function verifyWorkflowResult(): Promise<void> {
  const taskPayload = await getJson<{ items: TaskRecord[]; total: number }>(`/api/projects/${projectId}/tasks`);
  const projectPayload = await getJson<{ inboxSessions: string[] }>(`/api/projects/${projectId}`);
  const eventsRaw = await getText(`/api/projects/${projectId}/events`);
  const events = parseNdjson(eventsRaw);
  const eventTypes = new Set(events.map((item) => String(item.eventType ?? "")));

  const devTask = taskPayload.items.find((item) => item.taskId === "task-dev-1");
  const qaTask = taskPayload.items.find((item) => item.taskId === "task-qa-1");

  assert(!!devTask, "task-dev-1 not found");
  assert(!!qaTask, "task-qa-1 not found");
  assert(devTask?.state === "WAITING_NEXT", "task-dev-1 expected WAITING_NEXT");
  assert(qaTask?.ownerRole === "qa", "task-qa-1 expected ownerRole=qa");
  assert(qaTask?.ownerSession === "session-qa", "task-qa-1 expected ownerSession=session-qa");
  assert(qaTask?.state === "TODO", "task-qa-1 expected TODO");
  assert(projectPayload.inboxSessions.includes("session-qa"), "session-qa inbox not created");
  assert(eventTypes.has("TASK_STATE_CHANGED"), "missing TASK_STATE_CHANGED event");
  assert(eventTypes.has("TASK_CREATED"), "missing TASK_CREATED event");
  assert(eventTypes.has("MANAGER_MESSAGE_ROUTED"), "missing MANAGER_MESSAGE_ROUTED event");

  console.log("[mock_workflow] verification passed");
  console.log(
    "[mock_workflow] tasks:",
    taskPayload.items.map((item) => ({
      taskId: item.taskId,
      state: item.state,
      ownerRole: item.ownerRole,
      ownerSession: item.ownerSession ?? null
    }))
  );
}

async function main() {
  await createProjectIfMissing();
  await createOrKeepInitialTask();
  await submitHandoffReport();
  await verifyWorkflowResult();
}

main().catch((error) => {
  console.error("[mock_workflow] failed:", error.message);
  process.exitCode = 1;
});
