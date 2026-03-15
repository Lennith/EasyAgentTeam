import fs from "node:fs/promises";
import path from "node:path";

export interface TimeoutMessageDumpInput {
  workspacePath: string;
  sessionId: string;
  providerSessionId?: string | null;
  sessionDir?: string | null;
  runId?: string | null;
  role?: string | null;
  provider?: string | null;
  dispatchId?: string | null;
  taskId?: string | null;
  timeoutStreak?: number | null;
}

export interface TimeoutMessageDumpResult {
  filePath: string;
  messageCount: number;
}

function buildTimeoutFileTimeToken(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export async function dumpSessionMessagesOnSoftTimeout(
  input: TimeoutMessageDumpInput
): Promise<TimeoutMessageDumpResult | null> {
  const targetSessionId = (input.providerSessionId?.trim() || input.sessionId).trim();
  if (!targetSessionId) {
    return null;
  }

  const sessionRoot = (input.sessionDir?.trim() || path.join(input.workspacePath, ".minimax", "sessions")).trim();
  const resolvedSessionRoot = path.resolve(sessionRoot);
  const sessionPath = path.join(resolvedSessionRoot, targetSessionId);
  const latestPreparedPath = path.join(sessionPath, "latest_llm_input_messages.json");
  let latestPreparedRaw = "";
  try {
    latestPreparedRaw = await fs.readFile(latestPreparedPath, "utf-8");
  } catch {
    return null;
  }
  const latestPrepared = JSON.parse(latestPreparedRaw) as { messages?: unknown[]; capturedAt?: string; stage?: string };
  const messages = Array.isArray(latestPrepared.messages) ? latestPrepared.messages : [];
  const capturedAt = new Date();
  const filePath = path.join(sessionPath, `timeout_error_${buildTimeoutFileTimeToken(capturedAt)}.json`);
  const payload = {
    capturedAt: capturedAt.toISOString(),
    runId: input.runId ?? null,
    role: input.role ?? null,
    sessionId: input.sessionId,
    providerSessionId: targetSessionId,
    provider: input.provider ?? null,
    dispatchId: input.dispatchId ?? null,
    taskId: input.taskId ?? null,
    timeoutStreak: input.timeoutStreak ?? null,
    source: "latest_llm_input_messages",
    sourceCapturedAt: latestPrepared.capturedAt ?? null,
    sourceStage: latestPrepared.stage ?? null,
    messageCount: messages.length,
    messages
  };
  await fs.mkdir(sessionPath, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
  return {
    filePath,
    messageCount: messages.length
  };
}
