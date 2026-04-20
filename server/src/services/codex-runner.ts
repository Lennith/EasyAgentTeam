import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { appendJsonlLine } from "../utils/file-utils.js";
import { appendEvent } from "../data/repository/project/event-repository.js";
import { touchSession } from "../data/repository/project/session-repository.js";
import type { ProjectPaths, ProjectRecord } from "../domain/models.js";
import type { RuntimeSettings } from "../data/repository/system/runtime-settings-repository.js";
import { runMiniMaxForProject, type MiniMaxRunResultInternal } from "./minimax-runner.js";
import { buildCodexTeamToolConfigArgs, type CodexTeamToolContext } from "./codex-teamtool-mcp.js";
import { spawnCodexProcess } from "./codex-cli-spawn.js";
import { buildProjectCodexRuntimeHome, ensureCodexRuntimeHome } from "./codex-runtime-home.js";
import { assertProviderModelLaunchable, normalizeCodexLaunchFailure } from "./provider-launch-error.js";

export interface ModelRunRequest {
  sessionId: string;
  prompt: string;
  dispatchId?: string;
  taskId?: string;
  activeTaskTitle?: string;
  activeParentTaskId?: string;
  activeRootTaskId?: string;
  activeRequestId?: string;
  agentRole?: string;
  timeoutMs?: number;
  resumeSessionId?: string;
  parentRequestId?: string;
  cliTool: "codex" | "minimax";
  modelCommand?: string;
  modelParams?: Record<string, any>;
  codexTeamToolContext?: CodexTeamToolContext;
}

export interface ModelRunResult {
  runId: string;
  command: string;
  args: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  logFile: string;
  sessionId?: string;
  mode: "exec" | "resume";
  pid?: number;
  debug?: {
    sessionIdDetectionAttempts: number;
    sessionIdDetectedAt?: string;
    sessionEndDetected?: boolean;
  };
}

export interface AgentOutputLine {
  schemaVersion: "1.0";
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
  config: {
    sandbox: "danger-full-access";
    approval: "never";
  };
}

export abstract class BaseModelRunner {
  protected readonly project: ProjectRecord;
  protected readonly paths: ProjectPaths;
  protected readonly request: ModelRunRequest;
  protected readonly runId: string;
  protected readonly startedAt: string;
  private lastHeartbeatTime = 0;
  private readonly heartbeatFailureKeys = new Set<string>();
  private static readonly HEARTBEAT_INTERVAL_MS = 1000;
  private static readonly HEARTBEAT_RETRY_DELAYS_MS = [0, 50, 150] as const;

  constructor(project: ProjectRecord, paths: ProjectPaths, request: ModelRunRequest) {
    this.project = project;
    this.paths = paths;
    this.request = request;
    this.runId = randomUUID();
    this.startedAt = new Date().toISOString();
  }

  abstract buildCommand(): { command: string; args: string[]; mode: "exec" | "resume" };
  abstract extractSessionId(line: string): string | undefined;

  async run(): Promise<ModelRunResult> {
    assertProviderModelLaunchable({
      providerId: "codex",
      model: typeof this.request.modelParams?.model === "string" ? this.request.modelParams.model : undefined
    });
    const { command, args, mode } = this.buildCommand();
    const cliCommand = [command, ...args].map((arg) => this.quoteCmdArg(arg)).join(" ");
    const workingDirectory = this.resolveWorkingDirectory();
    const codexHome = await ensureCodexRuntimeHome(
      buildProjectCodexRuntimeHome(this.paths, this.request.agentRole ?? this.request.sessionId)
    );

    await this.appendLog("system", `Starting ${this.request.cliTool} run (${mode}): ${command} ${args.join(" ")}`, {
      cliCommand,
      prompt: this.request.prompt
    });
    await this.appendLog("system", `Using isolated CODEX_HOME: ${codexHome}`);

    const child = spawnCodexProcess(command, args, {
      cwd: workingDirectory,
      env: this.withModelEnv(workingDirectory, codexHome),
      stdio: ["pipe", "pipe", "pipe"]
    });

    await this.appendEvent("CODEX_RUN_STARTED", {
      runId: this.runId,
      dispatchId: this.request.dispatchId ?? null,
      command,
      args,
      workingDirectory,
      provider: this.request.cliTool,
      mode,
      resumeSessionId: this.request.resumeSessionId ?? null,
      parentRequestId: this.request.parentRequestId ?? null,
      codexHome,
      pid: child.pid ?? null
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let capturedStdout = "";
    let capturedStderr = "";
    let timedOut = false;
    let spawnError: Error | null = null;
    let detectedSessionId = this.request.resumeSessionId?.trim() || "";
    let sessionIdDetectionAttempts = 0;
    let sessionIdDetectedAt: string | undefined;
    let sessionEndDetected = false;

    child.stdin.write(this.request.prompt);
    child.stdin.end();

    const timeout = setTimeout(
      () => {
        timedOut = true;
        child.kill();
      },
      this.request.timeoutMs || 10 * 60 * 1000
    );

    child.stdout.on("data", async (chunk: Buffer) => {
      capturedStdout += chunk.toString("utf8");
      stdoutBuffer += chunk.toString("utf8");
      const parsed = this.splitLines(stdoutBuffer);
      stdoutBuffer = parsed.rest;
      for (const line of parsed.lines.filter((item) => item.length > 0)) {
        sessionIdDetectionAttempts++;
        const sessionIdFromLine = this.extractSessionId(line);
        if (sessionIdFromLine) {
          detectedSessionId = sessionIdFromLine;
          sessionIdDetectedAt = new Date().toISOString();
          await this.appendLog("system", `Detected session ID: ${sessionIdFromLine}`);
        }

        if (this.isSessionEnd(line)) {
          sessionEndDetected = true;
          await this.appendLog("system", `Session end detected`);
        }

        await this.appendLog("stdout", line);
      }
    });

    child.stderr.on("data", async (chunk: Buffer) => {
      capturedStderr += chunk.toString("utf8");
      stderrBuffer += chunk.toString("utf8");
      const parsed = this.splitLines(stderrBuffer);
      stderrBuffer = parsed.rest;
      for (const line of parsed.lines.filter((item) => item.length > 0)) {
        sessionIdDetectionAttempts++;
        const sessionIdFromLine = this.extractSessionId(line);
        if (sessionIdFromLine) {
          detectedSessionId = sessionIdFromLine;
          sessionIdDetectedAt = new Date().toISOString();
          await this.appendLog("system", `Detected session ID: ${sessionIdFromLine}`);
        }

        if (this.isSessionEnd(line)) {
          sessionEndDetected = true;
          await this.appendLog("system", `Session end detected`);
        }

        await this.appendLog("stderr", line);
      }
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("error", async (error) => {
        spawnError = error;
        await this.appendLog("system", `spawn error: ${error.message}`);
        resolve(-1);
      });

      child.once("close", (code) => {
        resolve(code);
      });
    });

    clearTimeout(timeout);
    const finishedAt = new Date().toISOString();

    if (stdoutBuffer.trim().length > 0) {
      const sessionIdFromBuffer = this.extractSessionId(stdoutBuffer);
      if (sessionIdFromBuffer) {
        detectedSessionId = sessionIdFromBuffer;
      }
      await this.appendLog("stdout", stdoutBuffer.trim());
    }

    if (stderrBuffer.trim().length > 0) {
      const sessionIdFromBuffer = this.extractSessionId(stderrBuffer);
      if (sessionIdFromBuffer) {
        detectedSessionId = sessionIdFromBuffer;
      }
      await this.appendLog("stderr", stderrBuffer.trim());
    }

    await this.recordActivity({ reason: "run_finished", force: true });
    await this.appendLog("system", `${this.request.cliTool} finished with exitCode=${exitCode} timedOut=${timedOut}`);

    const normalizedLaunchError = normalizeCodexLaunchFailure({
      model: typeof this.request.modelParams?.model === "string" ? this.request.modelParams.model : undefined,
      stdout: `${capturedStdout}\n${stdoutBuffer}`,
      stderr: `${capturedStderr}\n${stderrBuffer}`,
      error: spawnError,
      command
    });
    if (normalizedLaunchError) {
      throw normalizedLaunchError;
    }

    await this.appendEvent("CODEX_RUN_FINISHED", {
      runId: this.runId,
      dispatchId: this.request.dispatchId ?? null,
      exitCode,
      timedOut,
      provider: this.request.cliTool,
      mode,
      providerSessionId: detectedSessionId || null
    });

    return {
      runId: this.runId,
      command,
      args,
      startedAt: this.startedAt,
      finishedAt,
      exitCode,
      timedOut,
      logFile: this.paths.agentOutputFile,
      sessionId: detectedSessionId || undefined,
      mode,
      pid: child.pid ?? undefined,
      debug: {
        sessionIdDetectionAttempts,
        sessionIdDetectedAt,
        sessionEndDetected
      }
    };
  }

  protected async appendEvent(eventType: string, payload: any): Promise<void> {
    await appendEvent(this.paths, {
      projectId: this.project.projectId,
      eventType,
      source: "manager",
      sessionId: this.request.sessionId,
      taskId: this.request.taskId,
      payload
    });
  }

  protected async appendLog(
    stream: "stdout" | "stderr" | "system",
    content: string,
    extra?: Partial<AgentOutputLine>
  ): Promise<void> {
    await appendJsonlLine(this.paths.agentOutputFile, {
      schemaVersion: "1.0",
      timestamp: new Date().toISOString(),
      projectId: this.project.projectId,
      runId: this.runId,
      sessionId: this.request.sessionId,
      taskId: this.request.taskId,
      stream,
      content,
      provider: this.request.cliTool,
      ...extra,
      config: {
        sandbox: "danger-full-access",
        approval: "never"
      }
    });
    const activity = this.resolveSessionActivity(stream, content);
    if (activity) {
      await this.recordActivity(activity);
    }
  }

  protected resolveSessionActivity(
    stream: "stdout" | "stderr" | "system",
    content: string
  ): { reason: string; force?: boolean; observedAt?: string } | null {
    if (stream === "system") {
      return null;
    }
    const clean = this.stripAnsi(content);
    if (!clean) {
      return null;
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(clean) as Record<string, unknown>;
    } catch {
      return null;
    }

    const eventType = typeof parsed.type === "string" ? parsed.type : "";
    if (eventType === "thread.started") {
      return { reason: "thread_started", force: true };
    }
    if (eventType === "turn.started") {
      return { reason: "turn_started" };
    }
    if (eventType === "turn.completed") {
      return { reason: "turn_completed", force: true };
    }
    if (eventType !== "item.started" && eventType !== "item.completed") {
      return null;
    }

    const item = parsed.item as Record<string, unknown> | undefined;
    const itemType = typeof item?.type === "string" ? item.type : "";
    if (!itemType) {
      return { reason: eventType };
    }

    const toolName = typeof item?.tool === "string" ? item.tool : "";
    const isTailTool =
      itemType === "mcp_tool_call" &&
      eventType === "item.completed" &&
      (toolName === "task_report_done" || toolName === "task_report_block");
    const isForce = isTailTool || (eventType === "item.completed" && itemType === "file_change");
    return {
      reason: `${eventType}:${itemType}${toolName ? `:${toolName}` : ""}`,
      force: isForce
    };
  }

  protected async writeHeartbeat(lastActiveAt: string): Promise<void> {
    await touchSession(this.paths, this.project.projectId, this.request.sessionId, { lastActiveAt });
  }

  protected async recordActivity(input: { reason: string; force?: boolean; observedAt?: string }): Promise<void> {
    const now = Date.now();
    if (!input.force && now - this.lastHeartbeatTime < BaseModelRunner.HEARTBEAT_INTERVAL_MS) {
      return;
    }
    const heartbeatAt = input.observedAt ?? new Date(now).toISOString();
    const persisted = await this.persistHeartbeat({
      lastActiveAt: heartbeatAt,
      reason: input.reason,
      force: input.force === true
    });
    if (persisted) {
      this.lastHeartbeatTime = now;
    }
  }

  private async persistHeartbeat(input: { lastActiveAt: string; reason: string; force: boolean }): Promise<boolean> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < BaseModelRunner.HEARTBEAT_RETRY_DELAYS_MS.length; attempt += 1) {
      const delayMs = BaseModelRunner.HEARTBEAT_RETRY_DELAYS_MS[attempt];
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      try {
        await this.writeHeartbeat(input.lastActiveAt);
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    await this.emitHeartbeatFailure(input, lastError);
    return false;
  }

  private async emitHeartbeatFailure(
    input: { lastActiveAt: string; reason: string; force: boolean },
    error: unknown
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error ?? "unknown heartbeat error");
    const dedupeKey = `${input.reason}:${message}`;
    if (this.heartbeatFailureKeys.has(dedupeKey)) {
      return;
    }
    this.heartbeatFailureKeys.add(dedupeKey);
    try {
      await this.appendEvent("SESSION_HEARTBEAT_TOUCH_FAILED", {
        runId: this.runId,
        provider: this.request.cliTool,
        lastActiveAt: input.lastActiveAt,
        reason: input.reason,
        force: input.force,
        attempts: BaseModelRunner.HEARTBEAT_RETRY_DELAYS_MS.length,
        error: message
      });
    } catch {
      // Ignore observability failures; runner flow should not crash on secondary event emission.
    }
  }

  protected resolveWorkingDirectory(): string {
    const role = this.request.agentRole?.trim();
    if (!role) {
      return this.project.workspacePath;
    }
    const roleWorkspace = path.resolve(this.project.workspacePath, "Agents", role);
    try {
      const stat = fs.statSync(roleWorkspace);
      if (stat.isDirectory()) {
        return roleWorkspace;
      }
    } catch {
      return this.project.workspacePath;
    }
    return this.project.workspacePath;
  }

  protected withModelEnv(workingDirectory: string, codexHome?: string): NodeJS.ProcessEnv {
    const baseEnv: NodeJS.ProcessEnv = process.env;
    const env: NodeJS.ProcessEnv = {
      ...baseEnv,
      AUTO_DEV_PROJECT_ID: this.project.projectId,
      AUTO_DEV_SESSION_ID: this.request.sessionId,
      AUTO_DEV_AGENT_ROLE: this.request.agentRole ?? "",
      AUTO_DEV_PROJECT_ROOT: this.project.workspacePath,
      AUTO_DEV_AGENT_WORKSPACE: workingDirectory,
      AUTO_DEV_MANAGER_URL: process.env.AUTO_DEV_MANAGER_URL ?? "http://127.0.0.1:43123",
      AUTO_DEV_PARENT_REQUEST_ID: this.request.parentRequestId ?? "",
      AUTO_DEV_ACTIVE_TASK_ID: this.request.taskId ?? "",
      AUTO_DEV_ACTIVE_TASK_TITLE: this.request.activeTaskTitle ?? "",
      AUTO_DEV_ACTIVE_PARENT_TASK_ID: this.request.activeParentTaskId ?? "",
      AUTO_DEV_ACTIVE_ROOT_TASK_ID: this.request.activeRootTaskId ?? "",
      AUTO_DEV_ACTIVE_REQUEST_ID: this.request.activeRequestId ?? "",
      ...(codexHome ? { CODEX_HOME: codexHome } : {})
    };

    if (process.platform !== "win32") {
      return env;
    }

    const currentPath = env.PATH ?? env.Path ?? "";
    const systemRoot =
      env.SystemRoot?.trim() || env.SYSTEMROOT?.trim() || env.windir?.trim() || env.WINDIR?.trim() || "C:\\Windows";
    const comSpec = env.ComSpec?.trim() || path.join(systemRoot, "System32", "cmd.exe");
    const programFiles = env["ProgramFiles"]?.trim();
    const programFilesX86 = env["ProgramFiles(x86)"]?.trim();

    const segments = currentPath
      .split(";")
      .map((item: string) => item.trim())
      .filter((item: string) => item.length > 0);
    const lowerSet = new Set(segments.map((item: string) => item.toLowerCase()));
    const appendCandidates: string[] = [];

    appendCandidates.push(path.join(systemRoot, "System32"));
    appendCandidates.push(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"));
    appendCandidates.push(path.join(systemRoot, "System32", "Wbem"));
    appendCandidates.push(path.join(systemRoot, "System32", "OpenSSH"));
    if (env.APPDATA) {
      appendCandidates.push(path.join(env.APPDATA, "npm"));
    }
    if (programFiles) {
      appendCandidates.push(path.join(programFiles, "PowerShell", "7"));
    }
    if (programFilesX86) {
      appendCandidates.push(path.join(programFilesX86, "PowerShell", "7"));
    }
    appendCandidates.push(path.dirname(process.execPath));

    for (const candidate of appendCandidates) {
      const normalized = candidate.trim();
      if (!normalized) {
        continue;
      }
      if (!lowerSet.has(normalized.toLowerCase())) {
        segments.push(normalized);
        lowerSet.add(normalized.toLowerCase());
      }
    }

    return {
      ...env,
      SystemRoot: systemRoot,
      SYSTEMROOT: systemRoot,
      windir: systemRoot,
      WINDIR: systemRoot,
      ComSpec: comSpec,
      PATH: segments.join(";"),
      Path: segments.join(";")
    };
  }

  protected quoteCmdArg(arg: string): string {
    if (arg.length === 0) {
      return '""';
    }
    if (!/[ \t"]/u.test(arg)) {
      return arg;
    }
    return `"${arg.replace(/"/g, '\\"')}"`;
  }

  protected splitLines(buffer: string): { lines: string[]; rest: string } {
    const lines = buffer.split(/\r?\n/);
    const rest = lines.pop() ?? "";
    return { lines, rest };
  }

  protected stripAnsi(content: string): string {
    return content.replace(/\u001b\[[0-9;]*m/g, "").trim();
  }

  protected isSessionEnd(line: string): boolean {
    const clean = this.stripAnsi(line).toLowerCase();

    const endPatterns = [
      /session\s+(ended|finished|completed|closed)/i,
      /conversation\s+(ended|finished|completed)/i,
      /turn\s+(ended|finished|completed)/i,
      /session\s+end/i,
      /conversation\s+end/i
    ];

    return endPatterns.some((pattern) => pattern.test(clean));
  }
}

export class CodexModelRunner extends BaseModelRunner {
  buildCommand(): { command: string; args: string[]; mode: "exec" | "resume" } {
    const command = this.request.modelCommand?.trim() || process.env.CODEX_CLI_COMMAND?.trim() || "codex";
    if (this.request.resumeSessionId && this.request.resumeSessionId.trim().length > 0) {
      const resume = [
        "exec",
        "resume",
        this.request.resumeSessionId.trim(),
        "--json",
        "--dangerously-bypass-approvals-and-sandbox"
      ];
      if (this.request.modelParams) {
        Object.entries(this.request.modelParams).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            resume.push(`--${key}`, String(value));
          }
        });
      }
      if (this.request.codexTeamToolContext) {
        resume.push(...buildCodexTeamToolConfigArgs(this.request.codexTeamToolContext));
      }
      return {
        command,
        args: resume,
        mode: "resume"
      };
    }

    const base = ["exec", "--json", "--sandbox", "danger-full-access", "--dangerously-bypass-approvals-and-sandbox"];
    if (this.request.modelParams) {
      Object.entries(this.request.modelParams).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          base.push(`--${key}`, String(value));
        }
      });
    }
    if (this.request.codexTeamToolContext) {
      base.push(...buildCodexTeamToolConfigArgs(this.request.codexTeamToolContext));
    }

    return { command, args: base, mode: "exec" };
  }

  extractSessionId(line: string): string | undefined {
    const clean = this.stripAnsi(line);

    try {
      const parsed = JSON.parse(clean) as Record<string, unknown>;
      const eventType = typeof parsed.type === "string" ? parsed.type : "";
      if (eventType === "thread.started" && typeof parsed.thread_id === "string") {
        return parsed.thread_id.trim();
      }
      if (typeof parsed.session_id === "string") {
        return parsed.session_id.trim();
      }
      if (typeof parsed.thread_id === "string") {
        return parsed.thread_id.trim();
      }
    } catch {
      // Non-JSON line, continue with plain-text fallbacks.
    }

    const patterns = [
      /session\s*id\s*[:=]\s*([0-9a-f-]{8,})/i,
      /session\s*[:=]\s*([0-9a-f-]{8,})/i,
      /session_id\s*[:=]\s*([0-9a-f-]{8,})/i
    ];

    for (const pattern of patterns) {
      const match = clean.match(pattern);
      if (match?.[1]) {
        return match[1].trim();
      }
    }

    return undefined;
  }
}

export function normalizeModelRunRequest(body: unknown): ModelRunRequest {
  if (!body || typeof body !== "object") {
    throw new Error("model run request must be an object");
  }

  const data = body as Record<string, unknown>;
  const sessionId = (data.sessionId ?? data.session_id) as string | undefined;
  const prompt = data.prompt as string | undefined;
  const taskId = (data.taskId ?? data.task_id ?? data.active_task_id ?? data.activeTaskId) as string | undefined;
  const dispatchId = (data.dispatchId ?? data.dispatch_id) as string | undefined;
  const activeTaskTitle = (data.active_task_title ?? data.activeTaskTitle) as string | undefined;
  const activeParentTaskId = (data.active_parent_task_id ?? data.activeParentTaskId) as string | undefined;
  const activeRootTaskId = (data.active_root_task_id ?? data.activeRootTaskId) as string | undefined;
  const activeRequestId = (data.active_request_id ?? data.activeRequestId) as string | undefined;
  const agentRole = (data.agentRole ?? data.agent_role) as string | undefined;
  const timeoutMsRaw = (data.timeoutMs ?? data.timeout_ms) as number | undefined;
  const resumeSessionId = (data.resumeSessionId ?? data.resume_session_id) as string | undefined;
  const parentRequestId = (data.parentRequestId ?? data.parent_request_id) as string | undefined;
  const cliToolRaw = (data.cliTool ?? data.cli_tool) as string | undefined;
  const modelCommand = (data.modelCommand ?? data.model_command) as string | undefined;
  const modelParams = data.modelParams ?? (data.model_params as Record<string, any> | undefined);
  const codexTeamToolContext = data.codexTeamToolContext ?? data.codex_teamtool_context;

  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("session_id is required");
  }
  if (!prompt || typeof prompt !== "string") {
    throw new Error("prompt is required");
  }

  const timeoutMs =
    typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? timeoutMsRaw
      : 10 * 60 * 1000;

  const cliTool = cliToolRaw === "trae" || cliToolRaw === "minimax" ? "minimax" : "codex";

  return {
    sessionId,
    prompt,
    taskId,
    dispatchId,
    activeTaskTitle,
    activeParentTaskId,
    activeRootTaskId,
    activeRequestId,
    agentRole,
    timeoutMs,
    resumeSessionId,
    parentRequestId,
    cliTool,
    modelCommand,
    modelParams,
    codexTeamToolContext:
      codexTeamToolContext && typeof codexTeamToolContext === "object"
        ? (codexTeamToolContext as CodexTeamToolContext)
        : undefined
  };
}

export async function runModelForProject(
  project: ProjectRecord,
  paths: ProjectPaths,
  body: unknown,
  runtimeSettings?: RuntimeSettings
): Promise<ModelRunResult | MiniMaxRunResultInternal> {
  const req = normalizeModelRunRequest(body);

  if (req.cliTool === "minimax") {
    if (!runtimeSettings) {
      throw new Error("Runtime settings required for MiniMax");
    }
    return await runMiniMaxForProject(
      project,
      paths,
      {
        sessionId: req.sessionId,
        prompt: req.prompt,
        taskId: req.taskId,
        dispatchId: req.dispatchId,
        activeTaskTitle: req.activeTaskTitle,
        activeParentTaskId: req.activeParentTaskId,
        activeRootTaskId: req.activeRootTaskId,
        activeRequestId: req.activeRequestId,
        agentRole: req.agentRole,
        timeoutMs: req.timeoutMs,
        resumeSessionId: req.resumeSessionId,
        parentRequestId: req.parentRequestId,
        cliTool: "minimax",
        model: req.modelParams?.model as string | undefined,
        modelParams: req.modelParams
      },
      runtimeSettings
    );
  }

  const runner: BaseModelRunner = new CodexModelRunner(project, paths, req);
  return await runner.run();
}
