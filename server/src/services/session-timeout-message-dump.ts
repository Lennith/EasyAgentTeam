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

interface TimeoutDumpTopMessage {
  index: number;
  role: string;
  toolName: string | null;
  chars: number;
  preview: string;
}

interface TimeoutDumpShareEntry {
  chars: number;
  pct: number;
}

interface TimeoutDumpAnalysis {
  topMessages: TimeoutDumpTopMessage[];
  roleCharShare: Record<string, TimeoutDumpShareEntry>;
  toolCharShare: Record<string, TimeoutDumpShareEntry>;
  fattestTool: { toolName: string; chars: number; pct: number } | null;
  totalChars: number;
  toolChars: number;
  toolCharPct: number;
}

function buildTimeoutFileTimeToken(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        const record = item as Record<string, unknown>;
        const type = typeof record.type === "string" ? record.type : "";
        if (type === "text") {
          return typeof record.text === "string" ? record.text : "";
        }
        if (type === "tool_result") {
          return typeof record.content === "string" ? record.content : "";
        }
        if (type === "tool_use") {
          try {
            return JSON.stringify(record.input ?? {});
          } catch {
            return "";
          }
        }
        return "";
      })
      .join("\n");
  }
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return String(content);
}

function pct(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Number(((part / total) * 100).toFixed(2));
}

function toPreview(value: string, maxChars: number = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 15))}...<truncated>`;
}

function buildTimeoutAnalysis(messages: unknown[]): TimeoutDumpAnalysis {
  const roleChars = new Map<string, number>();
  const toolCharsByName = new Map<string, number>();
  const topCandidates: TimeoutDumpTopMessage[] = [];
  let totalChars = 0;
  let toolChars = 0;

  messages.forEach((entry, index) => {
    const message = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const role = typeof message.role === "string" ? message.role : "unknown";
    const toolNameRaw = typeof message.name === "string" ? message.name.trim() : "";
    const toolName = toolNameRaw.length > 0 ? toolNameRaw : null;
    const text = stringifyContent(message.content);
    const chars = text.length;

    totalChars += chars;
    roleChars.set(role, (roleChars.get(role) ?? 0) + chars);
    if (role === "tool") {
      toolChars += chars;
      const toolKey = toolName ?? "(unknown_tool)";
      toolCharsByName.set(toolKey, (toolCharsByName.get(toolKey) ?? 0) + chars);
    }

    topCandidates.push({
      index,
      role,
      toolName,
      chars,
      preview: toPreview(text)
    });
  });

  topCandidates.sort((a, b) => b.chars - a.chars);
  const topMessages = topCandidates.slice(0, 5);

  const roleCharShare: Record<string, TimeoutDumpShareEntry> = {};
  for (const [role, chars] of roleChars.entries()) {
    roleCharShare[role] = { chars, pct: pct(chars, totalChars) };
  }

  const toolCharShare: Record<string, TimeoutDumpShareEntry> = {};
  let fattestTool: { toolName: string; chars: number; pct: number } | null = null;
  for (const [toolName, chars] of toolCharsByName.entries()) {
    const entry = { chars, pct: pct(chars, toolChars) };
    toolCharShare[toolName] = entry;
    if (!fattestTool || chars > fattestTool.chars) {
      fattestTool = { toolName, chars, pct: entry.pct };
    }
  }

  return {
    topMessages,
    roleCharShare,
    toolCharShare,
    fattestTool,
    totalChars,
    toolChars,
    toolCharPct: pct(toolChars, totalChars)
  };
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
    messages,
    analysis: buildTimeoutAnalysis(messages)
  };
  await fs.mkdir(sessionPath, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
  return {
    filePath,
    messageCount: messages.length
  };
}
