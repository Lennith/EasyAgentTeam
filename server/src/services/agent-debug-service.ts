interface AgentOutputLine {
  timestamp: string;
  projectId: string;
  runId: string;
  sessionId: string;
  taskId?: string;
  stream: "stdout" | "stderr" | "system";
  content: string;
  cliCommand?: string;
  prompt?: string;
  provider?: "codex" | "minimax";
}

type ParseMode = "thinking" | "exec" | "agent" | "codex" | null;

export type DebugAgentParsedLineType =
  | "system"
  | "assistant_output"
  | "assistant_note"
  | "reasoning"
  | "tool_call"
  | "tool_output"
  | "meta"
  | "status"
  | "token_usage"
  | "json_payload"
  | "error"
  | "marker"
  | "other";

export interface DebugAgentParsedLine {
  index: number;
  timestamp: string;
  stream: "stdout" | "stderr" | "system";
  raw: string;
  text: string;
  type: DebugAgentParsedLineType;
  json?: unknown;
}

interface DebugAgentRunMeta {
  workdir?: string;
  model?: string;
  provider?: string;
  providerSessionId?: string;
  reasoningEffort?: string;
  reasoningSummaries?: string;
  approval?: string;
  sandbox?: string;
  mcpStartup?: string;
}

interface DebugAgentRunSummary {
  finalOutput: string;
  cliCommand?: string;
  initialPrompt?: string;
  initialPromptSource?: "embedded" | "stderr_user_block";
  reasoning: string[];
  assistantNotes: string[];
  toolCalls: string[];
  toolOutputs: string[];
  errors: string[];
  warnings: string[];
  tokensUsed?: string;
  meta: DebugAgentRunMeta;
}

export interface DebugAgentRunDetail {
  runId: string;
  projectId: string;
  sessionId: string;
  taskId?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  lineCount: number;
  lineWindowStart: number;
  streams: {
    stdout: number;
    stderr: number;
    system: number;
  };
  summary: DebugAgentRunSummary;
  parsedLines: DebugAgentParsedLine[];
  provider?: "codex" | "minimax";
}

interface ParseRunOptions {
  limitLines: number;
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const FINISHED_PATTERN = /exitCode=([^\s]+)\s+timedOut=(true|false)/i;

function normalizeText(value: string): string {
  return value.replace(ANSI_PATTERN, "").trim();
}

function tryParseEmbeddedJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function parseMetaLine(summary: DebugAgentRunSummary, line: string): boolean {
  const match = line.match(/^([a-z ]+):\s*(.+)$/i);
  if (!match) {
    return false;
  }
  const key = match[1].trim().toLowerCase();
  const value = match[2].trim();
  if (value.length === 0) {
    return false;
  }

  if (key === "workdir") {
    summary.meta.workdir = value;
    return true;
  }
  if (key === "model") {
    summary.meta.model = value;
    return true;
  }
  if (key === "provider") {
    summary.meta.provider = value;
    return true;
  }
  if (key === "session id") {
    summary.meta.providerSessionId = value;
    return true;
  }
  if (key === "agent tool") {
    summary.meta.provider = value;
    return true;
  }
  if (key === "reasoning effort") {
    summary.meta.reasoningEffort = value;
    return true;
  }
  if (key === "reasoning summaries") {
    summary.meta.reasoningSummaries = value;
    return true;
  }
  if (key === "approval") {
    summary.meta.approval = value;
    return true;
  }
  if (key === "sandbox") {
    summary.meta.sandbox = value;
    return true;
  }
  if (key === "mcp startup") {
    summary.meta.mcpStartup = value;
    return true;
  }

  return false;
}

function extractPromptFromStderrUserBlock(rows: AgentOutputLine[]): string | undefined {
  const lines: string[] = [];
  let inUserBlock = false;

  for (const row of rows) {
    if (row.stream !== "stderr") {
      continue;
    }
    const clean = normalizeText(row.content ?? "");
    if (clean.length === 0) {
      continue;
    }
    const lower = clean.toLowerCase();
    if (!inUserBlock) {
      if (lower === "user") {
        inUserBlock = true;
      }
      continue;
    }

    if (
      lower === "thinking" ||
      lower === "exec" ||
      lower === "agent" ||
      lower === "codex" ||
      lower.startsWith("reconnecting")
    ) {
      break;
    }
    if (lower.startsWith("mcp startup:")) {
      continue;
    }
    lines.push(clean);
  }

  if (lines.length === 0) {
    return undefined;
  }
  return lines.join("\n");
}

function parseSingleRun(rows: AgentOutputLine[], options: ParseRunOptions): DebugAgentRunDetail {
  const runId = rows[0]?.runId ?? "";
  const projectId = rows[0]?.projectId ?? "";
  const sessionId = rows[0]?.sessionId ?? "";
  const taskId = rows.find((row) => typeof row.taskId === "string" && row.taskId.trim().length > 0)?.taskId;
  const provider = rows[0]?.provider ?? "minimax";
  const streams = { stdout: 0, stderr: 0, system: 0 };
  for (const row of rows) {
    streams[row.stream] += 1;
  }

  const lineWindowStart = Math.max(0, rows.length - options.limitLines);
  const sliced = rows.slice(lineWindowStart);
  const summary: DebugAgentRunSummary = {
    finalOutput: "",
    cliCommand:
      rows.find((row) => typeof row.cliCommand === "string" && row.cliCommand.trim().length > 0)?.cliCommand ??
      rows
        .find(
          (row) =>
            row.stream === "system" &&
            typeof row.content === "string" &&
            normalizeText(row.content).toLowerCase().startsWith("starting codex run")
        )
        ?.content.replace(/^Starting codex run(?:\s+\([^)]+\))?:\s*/i, ""),
    initialPrompt: rows.find((row) => typeof row.prompt === "string" && row.prompt.trim().length > 0)?.prompt,
    initialPromptSource: rows.some((row) => typeof row.prompt === "string" && row.prompt.trim().length > 0)
      ? "embedded"
      : undefined,
    reasoning: [],
    assistantNotes: [],
    toolCalls: [],
    toolOutputs: [],
    errors: [],
    warnings: [],
    meta: {
      provider
    }
  };
  if (!summary.initialPrompt) {
    const fallbackPrompt = extractPromptFromStderrUserBlock(rows);
    if (fallbackPrompt) {
      summary.initialPrompt = fallbackPrompt;
      summary.initialPromptSource = "stderr_user_block";
    }
  }
  const parsedLines: DebugAgentParsedLine[] = [];
  let mode: ParseMode = null;
  let awaitingTokenValue = false;
  let startedAt = rows[0]?.timestamp;
  let finishedAt = rows.length > 0 ? rows[rows.length - 1].timestamp : undefined;
  let exitCode: number | null | undefined;
  let timedOut: boolean | undefined;

  for (let i = 0; i < sliced.length; i += 1) {
    const row = sliced[i];
    const clean = normalizeText(row.content ?? "");
    if (clean.length === 0) {
      continue;
    }

    const lower = clean.toLowerCase();
    const json = tryParseEmbeddedJson(clean);
    let type: DebugAgentParsedLineType = "other";

    if (row.stream === "system") {
      type = "system";
      if (lower.startsWith("starting codex run")) {
        startedAt = row.timestamp;
      }
      const finishedMatch = clean.match(FINISHED_PATTERN);
      if (finishedMatch) {
        const parsedExit = Number(finishedMatch[1]);
        exitCode = Number.isNaN(parsedExit) ? null : parsedExit;
        timedOut = finishedMatch[2].toLowerCase() === "true";
        finishedAt = row.timestamp;
      }
    } else if (row.stream === "stdout") {
      type = "assistant_output";
      summary.finalOutput = summary.finalOutput.length > 0 ? `${summary.finalOutput}\n${clean}` : clean;
    } else {
      if (lower === "thinking") {
        mode = "thinking";
        type = "marker";
      } else if (lower === "exec") {
        mode = "exec";
        type = "marker";
      } else if (lower === "agent" || lower === "codex") {
        mode = lower as ParseMode;
        type = "marker";
      } else if (lower.includes("tokens used")) {
        awaitingTokenValue = true;
        type = "token_usage";
      } else if (awaitingTokenValue && /^[\d,]+$/.test(clean)) {
        summary.tokensUsed = clean;
        awaitingTokenValue = false;
        type = "token_usage";
      } else if (/^".*"\s+in\s+.+$/u.test(clean)) {
        summary.toolCalls.push(clean);
        type = "tool_call";
      } else if (mode === "thinking" && clean.startsWith("**")) {
        summary.reasoning.push(clean.replace(/^\*+|\*+$/g, "").trim());
        type = "reasoning";
      } else if (mode === "agent" || mode === "codex") {
        summary.assistantNotes.push(clean);
        type = "assistant_note";
      } else if (parseMetaLine(summary, clean)) {
        type = "meta";
      } else if (json !== undefined) {
        type = "json_payload";
      } else if (lower.includes("warning")) {
        summary.warnings.push(clean);
        type = "status";
      } else if (lower.startsWith("reconnecting")) {
        type = "status";
      } else if (
        lower.startsWith("succeeded in") ||
        lower.startsWith("exited ") ||
        lower.startsWith("fatal:") ||
        lower.startsWith("error:")
      ) {
        summary.toolOutputs.push(clean);
        type = lower.startsWith("fatal:") || lower.startsWith("error:") ? "error" : "tool_output";
        if (type === "error") {
          summary.errors.push(clean);
        }
      } else if (mode === "exec" && clean.length > 0) {
        summary.toolOutputs.push(clean);
        type = "tool_output";
      }
    }

    parsedLines.push({
      index: lineWindowStart + i + 1,
      timestamp: row.timestamp,
      stream: row.stream,
      raw: row.content,
      text: clean,
      type,
      json
    });
  }

  return {
    runId,
    projectId,
    sessionId,
    taskId,
    startedAt,
    finishedAt,
    exitCode,
    timedOut,
    lineCount: rows.length,
    lineWindowStart,
    streams,
    summary,
    parsedLines,
    provider
  };
}

export function buildAgentRunDetails(
  rows: AgentOutputLine[],
  options: { limitRuns?: number; limitLines?: number } = {}
): DebugAgentRunDetail[] {
  const byRunId = new Map<string, AgentOutputLine[]>();
  for (const row of rows) {
    const runId = row.runId?.trim();
    if (!runId) {
      continue;
    }
    const bucket = byRunId.get(runId) ?? [];
    bucket.push(row);
    byRunId.set(runId, bucket);
  }

  const runRows = Array.from(byRunId.entries()).map(([runId, items]) => ({
    runId,
    rows: items,
    latestTimestamp: items.length > 0 ? items[items.length - 1].timestamp : ""
  }));
  runRows.sort((a, b) => Date.parse(b.latestTimestamp) - Date.parse(a.latestTimestamp));

  const limitRunsRaw = options.limitRuns ?? 20;
  const limitRuns = Number.isFinite(limitRunsRaw) ? Math.max(1, Math.min(2000, Math.floor(limitRunsRaw))) : 20;
  const limitLinesRaw = options.limitLines ?? 180;
  const limitLines = Number.isFinite(limitLinesRaw) ? Math.max(20, Math.min(1000, Math.floor(limitLinesRaw))) : 180;

  return runRows.slice(0, limitRuns).map((item) => parseSingleRun(item.rows, { limitLines }));
}
