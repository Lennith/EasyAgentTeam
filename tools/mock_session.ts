const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const projectId = process.env.PROJECT_ID ?? `demo_session_${Date.now()}`;
const workspacePath = process.env.WORKSPACE_PATH ?? "D:/AiAgent/AutoDevelopFramework";

async function postJson(pathname: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { status: response.status, body };
}

async function getJson(pathname: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${pathname}`);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`GET ${pathname} failed: HTTP ${response.status} ${text}`);
  }
  return body;
}

async function createProjectIfMissing(): Promise<void> {
  const result = await postJson("/api/projects", {
    project_id: projectId,
    name: "Demo Session Step4",
    workspace_path: workspacePath
  });
  if (result.status === 201) {
    console.log("[mock_session] project created");
    return;
  }
  if (result.status === 409) {
    console.log("[mock_session] project already exists");
    return;
  }
  throw new Error(`create project failed: ${result.status} ${JSON.stringify(result.body)}`);
}

async function runFlow(): Promise<void> {
  const add = await postJson(`/api/projects/${projectId}/sessions`, {
    session_id: "sess-dev-1",
    role: "dev_backend"
  });
  if (![200, 201].includes(add.status)) {
    throw new Error(`add session failed: ${add.status} ${JSON.stringify(add.body)}`);
  }
  console.log("[mock_session] session added:", add.body);

  const send = await postJson(`/api/projects/${projectId}/messages/send`, {
    to: { agent: "dev_backend", session_id: null },
    content: "请处理 task-001，回传结果。",
    mode: "CHAT"
  });
  if (send.status !== 201) {
    throw new Error(`send message failed: ${send.status} ${JSON.stringify(send.body)}`);
  }
  console.log("[mock_session] message routed:", send.body);

  const inbox = await getJson(`/api/projects/${projectId}/inbox/sess-dev-1?limit=1`);
  console.log("[mock_session] inbox tail:", inbox);
}

async function main() {
  await createProjectIfMissing();
  await runFlow();
}

main().catch((error) => {
  console.error("[mock_session] failed:", error.message);
  process.exitCode = 1;
});
