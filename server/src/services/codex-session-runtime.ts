import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { composeSystemPrompt } from "./prompt-composer.js";
import { resolveSkillPromptSegments } from "./skill-catalog.js";
import { buildCodexTeamToolConfigArgs } from "./codex-teamtool-mcp.js";
import { spawnCodexProcess } from "./codex-cli-spawn.js";
import { buildSessionCodexRuntimeHome, ensureCodexRuntimeHome } from "./codex-runtime-home.js";
import { assertProviderModelLaunchable, normalizeCodexLaunchFailure } from "./provider-launch-error.js";
import type { RuntimeSettings } from "../data/repository/system/runtime-settings-repository.js";
import type { MiniMaxRunResult } from "../minimax/index.js";
import type { ProviderSessionRunInput } from "./provider-session-types.js";

interface ParsedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: raw };
    } catch {
      return { value: raw };
    }
  }
  if (typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return { value: raw };
}

function stringifyContent(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw === undefined || raw === null) {
    return "";
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function formatStructuredToolError(payload: Record<string, unknown>): string | undefined {
  const errorCode = typeof payload.error_code === "string" ? payload.error_code.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  if (!errorCode && !message) {
    return undefined;
  }
  if (errorCode && message) {
    return `${errorCode}: ${message}`;
  }
  return errorCode || message;
}

function normalizeToolResultContent(raw: unknown): string {
  const text = extractText(raw);
  if (text) {
    return text;
  }
  return stringifyContent(raw);
}

export function normalizeCodexToolResultItem(item: Record<string, unknown>): {
  success: boolean;
  content: string;
  error?: string;
} {
  const structuredPayload =
    parseJsonObject(item.structuredContent ?? item.structured_content) ??
    parseJsonObject(
      extractText(item.content) ?? extractText(item.output) ?? extractText(item.result) ?? extractText(item.message)
    );
  const content = structuredPayload
    ? JSON.stringify(structuredPayload)
    : normalizeToolResultContent(item.output ?? item.result ?? item.content ?? item.message ?? "");
  const explicitError =
    typeof item.error === "string"
      ? item.error
      : typeof item.message === "string" && item.is_error === true
        ? item.message
        : undefined;
  const structuredError = structuredPayload ? formatStructuredToolError(structuredPayload) : undefined;
  const error = item.is_error === true ? (explicitError ?? structuredError ?? "Tool call failed") : explicitError;
  return {
    success: item.is_error !== true && !error,
    content,
    ...(error ? { error } : {})
  };
}

function parseUsage(raw: unknown): ParsedUsage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const usage = raw as Record<string, unknown>;
  const promptTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const completionTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : promptTokens + completionTokens;
  if (promptTokens <= 0 && completionTokens <= 0 && totalTokens <= 0) {
    return undefined;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens
  };
}

function extractText(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? raw : undefined;
  }
  if (Array.isArray(raw)) {
    const joined = raw
      .map((item) => {
        if (!item || typeof item !== "object") {
          return typeof item === "string" ? item : "";
        }
        const entry = item as Record<string, unknown>;
        return typeof entry.text === "string" ? entry.text : typeof entry.content === "string" ? entry.content : "";
      })
      .filter((item) => item.trim().length > 0)
      .join("\n");
    return joined.trim().length > 0 ? joined : undefined;
  }
  if (raw && typeof raw === "object") {
    const entry = raw as Record<string, unknown>;
    if (typeof entry.text === "string") {
      return entry.text;
    }
    if (typeof entry.content === "string") {
      return entry.content;
    }
    if (typeof entry.summary === "string") {
      return entry.summary;
    }
  }
  return undefined;
}

export function looksLikeCodexThreadId(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.trim());
}

function normalizeReasoningEffort(raw: string | undefined): "low" | "medium" | "high" | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "low" || normalized === "medium" || normalized === "high" ? normalized : undefined;
}

export function resolveCodexToolName(item: Record<string, unknown>, fallback: string = "unknown_tool"): string {
  if (typeof item.name === "string" && item.name.trim()) {
    return item.name;
  }
  if (
    item.function &&
    typeof item.function === "object" &&
    typeof (item.function as Record<string, unknown>).name === "string" &&
    ((item.function as Record<string, unknown>).name as string).trim()
  ) {
    return (item.function as Record<string, unknown>).name as string;
  }
  if (typeof item.tool_name === "string" && item.tool_name.trim()) {
    return item.tool_name;
  }
  if (typeof item.tool === "string" && item.tool.trim()) {
    return item.tool;
  }
  return fallback;
}

function buildCodexPrompt(systemPrompt: string, userPrompt: string): string {
  return [
    "<system_prompt>",
    systemPrompt.trim(),
    "</system_prompt>",
    "",
    "<user_request>",
    userPrompt,
    "</user_request>"
  ].join("\n");
}

export function buildCodexSessionArgs(
  input: Pick<ProviderSessionRunInput, "providerSessionId" | "model" | "reasoningEffort" | "codexTeamToolContext">
): {
  args: string[];
  shouldResume: boolean;
} {
  const requestedSessionId = input.providerSessionId.trim();
  const shouldResume = looksLikeCodexThreadId(requestedSessionId);
  const args = shouldResume
    ? ["exec", "resume", requestedSessionId, "--json", "--dangerously-bypass-approvals-and-sandbox"]
    : ["exec", "--json", "--sandbox", "danger-full-access", "--dangerously-bypass-approvals-and-sandbox"];

  if (input.model?.trim()) {
    args.push("--model", input.model.trim());
  }
  const reasoningEffort = normalizeReasoningEffort(input.reasoningEffort);
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
  }
  if (input.codexTeamToolContext) {
    args.push(...buildCodexTeamToolConfigArgs(input.codexTeamToolContext));
  }

  return { args, shouldResume };
}

export class CodexSessionRuntime {
  private static readonly KEEPALIVE_INTERVAL_MS = 15_000;
  private readonly activeSessions = new Map<string, ChildProcessWithoutNullStreams>();

  private registerSessionKey(sessionKey: string, child: ChildProcessWithoutNullStreams): void {
    const normalized = sessionKey.trim();
    if (!normalized) {
      return;
    }
    this.activeSessions.set(normalized, child);
  }

  private unregisterSessionKeys(sessionKeys: Iterable<string>, child: ChildProcessWithoutNullStreams): void {
    for (const sessionKey of sessionKeys) {
      const normalized = sessionKey.trim();
      if (!normalized) {
        continue;
      }
      const active = this.activeSessions.get(normalized);
      if (active === child) {
        this.activeSessions.delete(normalized);
      }
    }
  }

  async runSessionWithTools(settings: RuntimeSettings, input: ProviderSessionRunInput): Promise<MiniMaxRunResult> {
    const skillPrompt = resolveSkillPromptSegments({
      manifestPath: input.skillManifestPath ?? process.env.AUTO_DEV_SKILL_MANIFEST,
      providerId: "codex",
      contextKind: input.contextKind,
      requestedSkillIds: input.skillIds,
      requiredSkillIds: input.requiredSkillIds
    });
    if (skillPrompt.missingRequiredSkillIds.length > 0) {
      throw new Error(`SKILL_REQUIRED_MISSING: ${skillPrompt.missingRequiredSkillIds.join(", ")}`);
    }

    const promptCompose = composeSystemPrompt({
      providerId: "codex",
      hostPlatform: process.platform,
      role: input.role,
      rolePrompt: input.rolePrompt,
      contextKind: input.contextKind,
      contextOverride: input.contextOverride,
      runtimeConstraints: input.runtimeConstraints,
      skillSegments: [...(input.skillSegments ?? []), ...skillPrompt.segments]
    });

    const configuredCommand = settings.codexCliCommand?.trim() || "codex";
    assertProviderModelLaunchable({
      providerId: "codex",
      model: input.model
    });
    const requestedSessionId = input.providerSessionId.trim();
    const { args, shouldResume } = buildCodexSessionArgs(input);
    const codexHome = await ensureCodexRuntimeHome(
      buildSessionCodexRuntimeHome({
        sessionDirFallback: input.sessionDirFallback,
        workspaceRoot: input.workspaceRoot,
        role: input.role,
        codexTeamToolContext: input.codexTeamToolContext
      })
    );

    const child = spawnCodexProcess(configuredCommand, args, {
      cwd: input.workspaceDir,
      env: {
        ...process.env,
        ...(input.env ?? {}),
        CODEX_HOME: codexHome
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const trackedKeys = new Set<string>([requestedSessionId]);
    this.registerSessionKey(requestedSessionId, child);
    const pendingObservationCallbacks: Array<Promise<unknown>> = [];
    let lastKeepaliveAt = 0;

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let rawStdout = "";
    let rawStderr = "";
    let actualSessionId = shouldResume ? requestedSessionId : "";
    let usage: ParsedUsage | undefined;
    let finishReason = child.exitCode === 0 ? "stop" : undefined;
    let step = 0;
    const assistantMessages: string[] = [];
    const toolCallNames = new Map<string, string>();

    const emitObservation = (kind: string, details?: Record<string, unknown>) => {
      const callback = input.callback?.onProviderObservation;
      if (!callback) {
        return;
      }
      try {
        const pending = callback({
          providerId: "codex",
          kind,
          role: input.role,
          providerSessionId: actualSessionId || requestedSessionId || undefined,
          step: step > 0 ? step : undefined,
          details
        });
        if (pending && typeof (pending as PromiseLike<unknown>).then === "function") {
          pendingObservationCallbacks.push(Promise.resolve(pending).catch(() => undefined));
        }
      } catch {
        // Keep provider observation non-blocking for session execution.
      }
    };

    const emitKeepalive = (source: "timer" | "stdout" | "stderr", force: boolean = false) => {
      const now = Date.now();
      if (!force && now - lastKeepaliveAt < CodexSessionRuntime.KEEPALIVE_INTERVAL_MS) {
        return;
      }
      lastKeepaliveAt = now;
      emitObservation("heartbeat", {
        source,
        pid: child.pid ?? null
      });
    };

    emitObservation("launch_config", {
      model: input.model ?? null,
      effort: input.reasoningEffort ?? null,
      should_resume: shouldResume,
      requested_session_id: requestedSessionId || null,
      working_directory: input.workspaceDir
    });
    const keepaliveTimer = setInterval(() => {
      emitKeepalive("timer", true);
    }, CodexSessionRuntime.KEEPALIVE_INTERVAL_MS);
    keepaliveTimer.unref?.();

    const flushPendingObservations = async () => {
      if (pendingObservationCallbacks.length === 0) {
        return;
      }
      const pending = pendingObservationCallbacks.splice(0, pendingObservationCallbacks.length);
      await Promise.allSettled(pending);
    };

    const flushLine = (stream: "stdout" | "stderr", line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let event: Record<string, unknown> | null = null;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        if (stream === "stderr" && trimmed.length > 0) {
          return;
        }
        return;
      }

      const eventType = typeof event.type === "string" ? event.type : "";
      if (eventType === "thread.started") {
        const threadId = typeof event.thread_id === "string" ? event.thread_id.trim() : "";
        if (threadId) {
          actualSessionId = threadId;
          trackedKeys.add(threadId);
          this.registerSessionKey(threadId, child);
          emitObservation("thread_started", {
            thread_id: threadId
          });
        }
        return;
      }
      if (eventType === "turn.completed") {
        usage = parseUsage(event.usage) ?? usage;
        finishReason = typeof event.finish_reason === "string" ? event.finish_reason : (finishReason ?? "stop");
        emitObservation("turn_completed", {
          finish_reason: finishReason ?? "stop",
          usage: usage
            ? {
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens,
                totalTokens: usage.totalTokens
              }
            : undefined
        });
        return;
      }
      if (eventType === "turn.started") {
        step += 1;
        input.callback?.onStep?.(step, step);
        emitObservation("turn_started", {
          step
        });
        return;
      }

      const item = event.item && typeof event.item === "object" ? (event.item as Record<string, unknown>) : event;
      const itemType = typeof item.type === "string" ? item.type : eventType;
      if (itemType === "agent_message") {
        const text = extractText(item.text ?? item.content ?? item.message);
        if (text) {
          assistantMessages.push(text);
          input.callback?.onMessage?.("assistant", text);
        }
        return;
      }
      if (itemType === "reasoning" || itemType === "thinking") {
        const thinking = extractText(item.text ?? item.content ?? item.summary);
        if (thinking) {
          input.callback?.onThinking?.(thinking);
        }
        return;
      }
      if (itemType === "mcp_tool_call" || itemType === "tool_call" || itemType === "function_call") {
        const toolId =
          typeof item.id === "string" ? item.id : typeof item.tool_call_id === "string" ? item.tool_call_id : undefined;
        const name = resolveCodexToolName(item);
        const argsRaw =
          item.arguments ??
          item.args ??
          item.input ??
          (item.function && typeof item.function === "object"
            ? (item.function as Record<string, unknown>).arguments
            : undefined);
        if (toolId) {
          toolCallNames.set(toolId, name);
        }
        input.callback?.onToolCall?.(name, parseArguments(argsRaw));
        emitObservation("tool_call", {
          tool_name: name,
          tool_id: toolId ?? null
        });
        return;
      }
      if (itemType === "mcp_tool_result" || itemType === "tool_result" || itemType === "function_result") {
        const toolId =
          typeof item.id === "string" ? item.id : typeof item.tool_call_id === "string" ? item.tool_call_id : undefined;
        const name = (toolId ? toolCallNames.get(toolId) : undefined) ?? resolveCodexToolName(item);
        const normalizedResult = normalizeCodexToolResultItem(item);
        input.callback?.onToolResult?.(name, normalizedResult);
        emitObservation("tool_result", {
          tool_name: name,
          tool_id: toolId ?? null,
          success: normalizedResult.success,
          error: normalizedResult.error ?? null
        });
      }
    };

    const processBuffer = (stream: "stdout" | "stderr", chunk: Buffer, buffer: string): string => {
      const nextBuffer = buffer + chunk.toString("utf8");
      const parts = nextBuffer.split(/\r?\n/);
      const rest = parts.pop() ?? "";
      for (const line of parts) {
        flushLine(stream, line);
      }
      return rest;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      emitKeepalive("stdout");
      rawStdout += chunk.toString("utf8");
      stdoutBuffer = processBuffer("stdout", chunk, stdoutBuffer);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      emitKeepalive("stderr");
      rawStderr += chunk.toString("utf8");
      stderrBuffer = processBuffer("stderr", chunk, stderrBuffer);
    });

    const combinedPrompt = buildCodexPrompt(promptCompose.systemPrompt, input.prompt);
    child.stdin.write(combinedPrompt);
    child.stdin.end();

    const closeResult = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
      }
    ).catch(async (error) => {
      clearInterval(keepaliveTimer);
      const normalized =
        error && typeof error === "object" && "code" in (error as Record<string, unknown>)
          ? (normalizeCodexLaunchFailure({
              model: input.model,
              error,
              command: configuredCommand
            }) ?? (error instanceof Error ? error : new Error(String(error))))
          : error instanceof Error
            ? error
            : new Error(String(error));
      emitObservation("launch_error", {
        message: normalized.message,
        error_name: normalized.name
      });
      await flushPendingObservations();
      input.callback?.onError?.(normalized);
      throw normalized;
    });
    clearInterval(keepaliveTimer);

    const exitCode = closeResult.exitCode;
    const exitSignal = closeResult.signal;

    if (stdoutBuffer.trim().length > 0) {
      flushLine("stdout", stdoutBuffer.trim());
    }
    if (stderrBuffer.trim().length > 0) {
      flushLine("stderr", stderrBuffer.trim());
    }

    this.unregisterSessionKeys(trackedKeys, child);

    const content = assistantMessages.join("\n\n").trim();
    if (exitCode !== 0) {
      const error =
        normalizeCodexLaunchFailure({
          model: input.model,
          stdout: `${rawStdout}\n${stdoutBuffer}`,
          stderr: `${rawStderr}\n${stderrBuffer}`,
          command: configuredCommand
        }) ??
        new Error(
          stderrBuffer.trim() ||
            (exitSignal
              ? `codex session exited with signal ${exitSignal}`
              : `codex session exited with code ${String(exitCode)}`)
        );
      emitObservation("launch_error", {
        message: error.message,
        error_name: error.name,
        exit_code: exitCode ?? null,
        exit_signal: exitSignal ?? null
      });
      await flushPendingObservations();
      input.callback?.onError?.(error);
      throw error;
    }

    const result: MiniMaxRunResult = {
      content,
      sessionId: actualSessionId || requestedSessionId,
      providerSessionId: actualSessionId || requestedSessionId,
      isNewSession: !shouldResume,
      finishReason: finishReason ?? "stop",
      step: step > 0 ? step : undefined,
      usage
    };
    emitObservation("run_completed", {
      finish_reason: result.finishReason ?? "stop",
      assistant_message_count: assistantMessages.length,
      usage: result.usage
        ? {
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens
          }
        : undefined
    });
    await flushPendingObservations();
    input.callback?.onComplete?.(result.content, result.finishReason, {
      finishReason: result.finishReason,
      usage: result.usage,
      step: result.step ?? Math.max(step, 1),
      recoveredFromMaxTokens: false
    });
    return result;
  }

  cancelSession(sessionId: string): boolean {
    const active = this.activeSessions.get(sessionId.trim());
    if (!active) {
      return false;
    }
    active.kill();
    return true;
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId.trim());
  }
}
