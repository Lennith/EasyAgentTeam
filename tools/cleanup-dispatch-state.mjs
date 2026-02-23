import fs from "node:fs/promises";
import path from "node:path";

function parseJsonFile(filePath, fallback) {
  return fs.readFile(filePath, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => fallback);
}

async function writeJsonFile(filePath, data) {
  const body = `${JSON.stringify(data, null, 2)}\n`;
  await fs.writeFile(filePath, body, "utf8");
}

function dedupeRows(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = `${row.taskId ?? ""}::${row.ownerSession ?? ""}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }
    const prevTs = Date.parse(prev.createdAt ?? "");
    const nextTs = Date.parse(row.createdAt ?? "");
    if (!Number.isFinite(prevTs) || nextTs >= prevTs) {
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values());
}

function parseJsonl(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function main() {
  const projectId = process.argv[2] ?? "DMS_Doc";
  const dataRootArg = process.argv[3];
  const dataRoot = dataRootArg ? path.resolve(dataRootArg) : path.resolve("data");
  const projectRoot = path.join(dataRoot, "projects", projectId);
  const collabDir = path.join(projectRoot, "collab");
  const outboxDir = path.join(collabDir, "outbox");
  const sessionsFile = path.join(collabDir, "state", "sessions.json");
  const taskboardFile = path.join(collabDir, "state", "taskboard.json");

  const summary = {
    projectId,
    removedManagerSystemBuffer: false,
    dedupedBufferFiles: 0,
    removedDoneTaskBufferRows: 0,
    rewrittenBufferFiles: 0,
    removedBufferFiles: 0,
    repairedRunningSessions: 0,
    taskOwnerSessionRepairs: 0
  };

  const taskboard = await parseJsonFile(taskboardFile, null);
  const sessions = await parseJsonFile(sessionsFile, null);
  if (!taskboard || !sessions) {
    throw new Error(`Missing runtime state for project '${projectId}' under ${collabDir}`);
  }

  const taskById = new Map((taskboard.tasks ?? []).map((t) => [t.taskId, t]));
  const activeSessionsByRole = new Map();
  for (const session of sessions.sessions ?? []) {
    if (session.status === "dismissed") {
      continue;
    }
    const prev = activeSessionsByRole.get(session.role);
    if (!prev) {
      activeSessionsByRole.set(session.role, session);
      continue;
    }
    const prevTs = Date.parse(prev.lastActiveAt ?? prev.updatedAt ?? prev.createdAt ?? "");
    const nextTs = Date.parse(session.lastActiveAt ?? session.updatedAt ?? session.createdAt ?? "");
    if (!Number.isFinite(prevTs) || nextTs >= prevTs) {
      activeSessionsByRole.set(session.role, session);
    }
  }

  const managerBufferPath = path.join(outboxDir, "task-dispatch-buffer-manager-system.jsonl");
  try {
    await fs.unlink(managerBufferPath);
    summary.removedManagerSystemBuffer = true;
  } catch {}

  const outboxFiles = await fs.readdir(outboxDir).catch(() => []);
  for (const name of outboxFiles) {
    if (!name.startsWith("task-dispatch-buffer-") || !name.endsWith(".jsonl")) {
      continue;
    }
    const filePath = path.join(outboxDir, name);
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    const parsed = parseJsonl(raw);
    const deduped = dedupeRows(parsed);
    if (deduped.length < parsed.length) {
      summary.dedupedBufferFiles += 1;
    }
    const filtered = deduped.filter((row) => {
      const task = taskById.get(row.taskId);
      if (!task) {
        return false;
      }
      const terminal = task.state === "DONE" || task.state === "CANCELED";
      if (terminal) {
        summary.removedDoneTaskBufferRows += 1;
      }
      return !terminal;
    });
    if (filtered.length === 0) {
      await fs.unlink(filePath).catch(() => {});
      summary.removedBufferFiles += 1;
      continue;
    }
    const nextRaw = `${filtered.map((row) => JSON.stringify(row)).join("\n")}\n`;
    if (nextRaw !== raw) {
      await fs.writeFile(filePath, nextRaw, "utf8");
      summary.rewrittenBufferFiles += 1;
    }
  }

  const nowIso = new Date().toISOString();
  let sessionChanged = false;
  for (const session of sessions.sessions ?? []) {
    if (session.status !== "running") {
      continue;
    }
    const task = taskById.get(session.currentTaskId);
    const shouldIdle = task && (task.state === "DONE" || task.state === "CANCELED");
    session.status = shouldIdle ? "idle" : "blocked";
    session.updatedAt = nowIso;
    session.lastActiveAt = nowIso;
    if ("agentPid" in session) {
      session.agentPid = undefined;
    }
    summary.repairedRunningSessions += 1;
    sessionChanged = true;
  }

  let taskboardChanged = false;
  for (const task of taskboard.tasks ?? []) {
    if (task.state === "DONE" || task.state === "CANCELED") {
      continue;
    }
    const active = activeSessionsByRole.get(task.ownerRole);
    if (!active) {
      continue;
    }
    if (task.ownerSession !== active.sessionId) {
      task.ownerSession = active.sessionId;
      task.updatedAt = nowIso;
      taskboardChanged = true;
      summary.taskOwnerSessionRepairs += 1;
    }
  }

  if (sessionChanged) {
    sessions.updatedAt = nowIso;
    await writeJsonFile(sessionsFile, sessions);
  }
  if (taskboardChanged) {
    taskboard.updatedAt = nowIso;
    await writeJsonFile(taskboardFile, taskboard);
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

