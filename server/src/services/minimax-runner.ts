import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import { appendJsonlLine } from "../utils/file-utils.js";
import { appendEvent } from "../data/repository/project/event-repository.js";
import { touchSession } from "../data/repository/project/session-repository.js";
import type { ProjectPaths, ProjectRecord } from "../domain/models.js";
import type { RuntimeSettings } from "../data/repository/system/runtime-settings-repository.js";
import { logger } from "../utils/logger.js";
import { MiniMaxAgent, createMiniMaxAgent, type MiniMaxRunResult } from "../minimax/index.js";
import { isMiniMaxContextWindowExceededError, isMiniMaxToolResultIdNotFoundError } from "../minimax/llm/LLMClient.js";
import { createProjectToolExecutionAdapter, DefaultToolInjector } from "./tool-injector.js";
import { composeSystemPrompt } from "./prompt-composer.js";
import { resolveSkillPromptSegments } from "./skill-catalog.js";
import { getDefaultShellType } from "../runtime-platform.js";
import { resolveOrchestratorRolePromptSkillBundle } from "./orchestrator/shared/index.js";
import {
  normalizeMiniMaxRuntimeFailure,
  serializeProviderLaunchError,
  toProviderLaunchErrorPayload,
  type ProviderLaunchErrorPayload
} from "./provider-launch-error.js";

const activeRunners = new Map<string, MiniMaxRunner>();

export type MiniMaxCompletionCallback = (
  result: MiniMaxRunResultInternal,
  sessionId: string,
  runId: string
) => Promise<void>;

const completionCallbacks = new Map<string, MiniMaxCompletionCallback>();

export function registerMiniMaxCompletionCallback(runId: string, callback: MiniMaxCompletionCallback): void {
  completionCallbacks.set(runId, callback);
}

export function unregisterMiniMaxCompletionCallback(runId: string): void {
  completionCallbacks.delete(runId);
}

export type MiniMaxWakeUpCallback = (sessionId: string, runId: string) => Promise<void>;

const wakeUpCallbacks = new Map<string, MiniMaxWakeUpCallback>();

export function registerMiniMaxWakeUpCallback(runId: string, callback: MiniMaxWakeUpCallback): void {
  logger.info(`[MiniMaxRunner] registerMiniMaxWakeUpCallback: runId=${runId}`);
  wakeUpCallbacks.set(runId, callback);
}

export function unregisterMiniMaxWakeUpCallback(runId: string): void {
  wakeUpCallbacks.delete(runId);
}

export function cancelMiniMaxRunner(sessionId: string): boolean {
  const runner = activeRunners.get(sessionId);
  if (runner) {
    runner.cancel();
    return true;
  }
  return false;
}

export function isMiniMaxRunnerActive(sessionId: string): boolean {
  return activeRunners.has(sessionId);
}

export interface MiniMaxRunRequest {
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
  cliTool: "minimax";
  model?: string;
  modelParams?: Record<string, unknown>;
}

export interface MiniMaxRunResultInternal {
  runId: string;
  command: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  timedOut: boolean;
  logFile: string;
  sessionId?: string;
  error?: string;
  providerError?: ProviderLaunchErrorPayload;
  response?: MiniMaxRunResult;
}

export function isMiniMaxToolCallProtocolError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes("tool call result does not follow tool call") ||
    (normalized.includes("(2013)") && normalized.includes("invalid_request_error"))
  );
}

export function buildToolCallFailRecoveryPrompt(taskId?: string): string {
  const contextTask = taskId && taskId.trim().length > 0 ? taskId.trim() : "unknown-task";
  return [
    "[TOOLCALL_FAIL]",
    `The previous tool-call/result sequence was rejected by provider protocol checks (task=${contextTask}).`,
    "Ignore stale tool results, rebuild tool-call ordering, and continue the task from latest valid state.",
    "If shell/file operations are needed, issue fresh tool calls and continue normal reporting flow."
  ].join("\n");
}

export function buildContextWindowRecoveryPrompt(taskId?: string): string {
  const contextTask = taskId && taskId.trim().length > 0 ? taskId.trim() : "unknown-task";
  return [
    "[CONTEXT_WINDOW_RECOVERY]",
    `The previous request exceeded model context window (task=${contextTask}).`,
    "Continue with concise updates only: avoid dumping large files or repeated logs.",
    "Focus on next actionable step and continue task reporting."
  ].join("\n");
}

export class MiniMaxRunner {
  private readonly dataRoot: string;
  private readonly project: ProjectRecord;
  private readonly paths: ProjectPaths;
  private readonly request: MiniMaxRunRequest;
  private readonly settings: RuntimeSettings;
  private readonly runId: string;
  private readonly startedAt: string;
  private agent: MiniMaxAgent | null = null;
  private lastHeartbeatTime: number = 0;
  private static readonly HEARTBEAT_INTERVAL_MS = 1000;
  private cancelled = false;
  private wakeUpTriggered = false;

  cancel(): void {
    this.cancelled = true;
    if (this.agent) {
      this.agent.cancel();
    }
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  constructor(project: ProjectRecord, paths: ProjectPaths, request: MiniMaxRunRequest, settings: RuntimeSettings) {
    this.project = project;
    this.paths = paths;
    this.dataRoot = path.resolve(this.paths.projectRootDir, "..", "..");
    this.request = request;
    this.settings = settings;
    this.runId = randomUUID();
    this.startedAt = new Date().toISOString();
  }

  getRunId(): string {
    return this.runId;
  }

  getStartedAt(): string {
    return this.startedAt;
  }

  getLogFile(): string {
    return path.join(this.project.workspacePath, ".minimax", "runs", `${this.runId}.jsonl`);
  }

  private getSessionDir(): string {
    return (
      this.settings.providers?.minimax.sessionDir ??
      this.settings.minimaxSessionDir ??
      path.join(this.project.workspacePath, ".minimax", "sessions")
    );
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

  private async updateHeartbeat(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHeartbeatTime < MiniMaxRunner.HEARTBEAT_INTERVAL_MS) {
      return;
    }
    this.lastHeartbeatTime = now;
    try {
      await touchSession(this.paths, this.project.projectId, this.request.sessionId, {
        lastActiveAt: new Date().toISOString()
      });
    } catch (error) {
      logger.error(`[MiniMaxRunner] Failed to update heartbeat: ${(error as Error).message}`);
    }
  }

  private triggerWakeUp(): void {
    if (this.wakeUpTriggered) {
      return;
    }
    this.wakeUpTriggered = true;
    logger.info(`[MiniMaxRunner] triggerWakeUp: request.sessionId=${this.request.sessionId}, runId=${this.runId}`);
    const wakeUpCallback = wakeUpCallbacks.get(this.runId);
    if (wakeUpCallback) {
      logger.info(
        `[MiniMaxRunner] triggerWakeUp: found callback, calling with sessionId=${this.request.sessionId}, runId=${this.runId}`
      );
      wakeUpCallback(this.request.sessionId, this.runId).catch((error) => {
        logger.error(`[MiniMaxRunner] WakeUp callback error: ${(error as Error).message}`);
      });
    } else {
      logger.info(`[MiniMaxRunner] triggerWakeUp: NO callback found for runId=${this.runId}`);
    }
  }

  private async appendLog(
    stream: "stdout" | "stderr" | "system",
    content: string,
    extra?: Record<string, unknown>
  ): Promise<void> {
    const logLine = {
      schemaVersion: "1.0",
      timestamp: new Date().toISOString(),
      projectId: this.project.projectId,
      runId: this.runId,
      sessionId: this.request.sessionId,
      taskId: this.request.taskId,
      stream,
      content,
      provider: "minimax",
      ...extra
    };
    const logFile = this.getLogFile();
    await appendJsonlLine(logFile, logLine);
    await appendEvent(this.paths, {
      projectId: this.project.projectId,
      eventType: "MINIMAX_LOG",
      source: "agent",
      payload: logLine,
      sessionId: this.request.sessionId,
      taskId: this.request.taskId
    });
  }

  async run(): Promise<MiniMaxRunResultInternal> {
    const minimaxProfile = this.settings.providers?.minimax;
    const apiKey = minimaxProfile?.apiKey ?? this.settings.minimaxApiKey;
    const model =
      this.request.model ?? minimaxProfile?.model ?? this.settings.minimaxModel ?? "MiniMax-M2.5-High-speed";

    if (!apiKey) {
      const missingKeyError = "MiniMax API key not configured";
      await this.appendLog("system", "MiniMax API key not configured");
      return {
        runId: this.runId,
        command: "MiniMax Agent",
        startedAt: this.startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        timedOut: false,
        logFile: this.getLogFile(),
        sessionId: this.request.sessionId,
        error: missingKeyError
      };
    }

    await this.appendLog("system", `Starting MiniMax run with model: ${model}`);
    await this.appendLog("system", `Prompt: ${this.request.prompt.slice(0, 200)}...`);

    await appendEvent(this.paths, {
      projectId: this.project.projectId,
      eventType: "MINIMAX_RUN_STARTED",
      source: "agent",
      payload: {
        runId: this.runId,
        dispatchId: this.request.dispatchId ?? null,
        model,
        provider: "minimax",
        tokenLimit: minimaxProfile?.tokenLimit ?? this.settings.minimaxTokenLimit ?? 180000,
        maxOutputTokens: minimaxProfile?.maxOutputTokens ?? this.settings.minimaxMaxOutputTokens ?? 16384,
        resumeSessionId: this.request.resumeSessionId ?? null,
        parentRequestId: this.request.parentRequestId ?? null
      },
      sessionId: this.request.sessionId,
      taskId: this.request.taskId
    });

    try {
      const sessionDir = this.getSessionDir();
      const workingDirectory = this.resolveWorkingDirectory();

      await this.appendLog(
        "system",
        `[MiniMaxRunner] sessionDir from settings: ${minimaxProfile?.sessionDir ?? this.settings.minimaxSessionDir ?? "(not set)"}`
      );
      await this.appendLog("system", `[MiniMaxRunner] resolved sessionDir: ${sessionDir}`);
      await this.appendLog("system", `[MiniMaxRunner] workingDirectory: ${workingDirectory}`);
      await this.appendLog(
        "system",
        `[MiniMaxRunner] token_limit=${minimaxProfile?.tokenLimit ?? this.settings.minimaxTokenLimit ?? 180000}, max_output_tokens=${minimaxProfile?.maxOutputTokens ?? this.settings.minimaxMaxOutputTokens ?? 16384}`
      );
      const rolePromptSkillBundle = await resolveOrchestratorRolePromptSkillBundle({
        dataRoot: this.dataRoot,
        role: this.request.agentRole ?? ""
      });
      const skillPrompt = resolveSkillPromptSegments({
        manifestPath: process.env.AUTO_DEV_SKILL_MANIFEST,
        providerId: "minimax",
        contextKind: "project_dispatch",
        requestedSkillIds: rolePromptSkillBundle.skillIds
      });
      const promptCompose = composeSystemPrompt({
        providerId: "minimax",
        hostPlatform: process.platform,
        role: this.request.agentRole,
        rolePrompt: rolePromptSkillBundle.rolePrompt,
        contextKind: "project_dispatch",
        contextOverride: this.request.taskId ? `Active task: ${this.request.taskId}` : undefined,
        runtimeConstraints: ["Use task-action tool calls for create/discuss/report lifecycle updates."],
        skillSegments: [...rolePromptSkillBundle.skillSegments, ...skillPrompt.segments]
      });
      const toolInjection = DefaultToolInjector.build(
        createProjectToolExecutionAdapter({
          dataRoot: this.dataRoot,
          project: this.project,
          paths: this.paths,
          agentRole: this.request.agentRole ?? "",
          sessionId: this.request.sessionId,
          activeTaskId: this.request.taskId,
          activeTaskTitle: this.request.activeTaskTitle,
          activeParentTaskId: this.request.activeParentTaskId,
          activeRootTaskId: this.request.activeRootTaskId,
          activeRequestId: this.request.activeRequestId,
          parentRequestId: this.request.parentRequestId
        })
      );

      this.agent = createMiniMaxAgent({
        config: {
          apiKey,
          apiBase: minimaxProfile?.apiBase ?? this.settings.minimaxApiBase ?? "https://api.minimax.io",
          model,
          workspaceDir: workingDirectory,
          sessionDir,
          maxSteps: minimaxProfile?.maxSteps ?? this.settings.minimaxMaxSteps ?? 200,
          tokenLimit: minimaxProfile?.tokenLimit ?? this.settings.minimaxTokenLimit ?? 180000,
          maxOutputTokens: minimaxProfile?.maxOutputTokens ?? this.settings.minimaxMaxOutputTokens ?? 16384,
          enableFileTools: true,
          enableShell: true,
          enableNote: true,
          shellType: getDefaultShellType(),
          shellTimeout: minimaxProfile?.shellTimeout ?? this.settings.minimaxShellTimeout ?? 30000,
          shellOutputIdleTimeout:
            minimaxProfile?.shellOutputIdleTimeout ?? this.settings.minimaxShellOutputIdleTimeout ?? 60000,
          shellMaxRunTime: minimaxProfile?.shellMaxRunTime ?? this.settings.minimaxShellMaxRunTime ?? 600000,
          shellMaxOutputSize: minimaxProfile?.shellMaxOutputSize ?? this.settings.minimaxShellMaxOutputSize ?? 52428800,
          mcpEnabled: ((minimaxProfile?.mcpServers ?? this.settings.minimaxMcpServers)?.length ?? 0) > 0,
          mcpServers: minimaxProfile?.mcpServers ?? this.settings.minimaxMcpServers ?? [],
          mcpConnectTimeout: 30000,
          mcpExecuteTimeout: 60000,
          systemPrompt: promptCompose.systemPrompt,
          additionalWritableDirs: [this.project.workspacePath],
          teamToolContext: toolInjection.teamToolContext,
          teamToolBridge: toolInjection.teamToolBridge,
          env: {
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
            AUTO_DEV_ACTIVE_REQUEST_ID: this.request.activeRequestId ?? ""
          }
        }
      });

      const callback = {
        onThinking: (thinking: string) => {
          this.triggerWakeUp();
          this.updateHeartbeat().catch(() => {});
          this.appendLog("stdout", `[Thinking] ${thinking}`).catch(() => {});
        },
        onToolCall: (name: string, args: Record<string, unknown>) => {
          this.triggerWakeUp();
          this.updateHeartbeat().catch(() => {});
          this.appendLog("stdout", `[Tool Call] ${name}: ${JSON.stringify(args).slice(0, 200)}`).catch(() => {});
        },
        onToolResult: (name: string, result: { success: boolean; content: string; error?: string }) => {
          this.updateHeartbeat().catch(() => {});
          this.appendLog("stdout", `[Tool Result] ${name}: ${result.success ? "OK" : "ERROR"}`).catch(() => {});
        },
        onMessage: (role: string, content: string) => {
          this.triggerWakeUp();
          this.updateHeartbeat().catch(() => {});
          this.appendLog("stdout", `[${role}] ${content.slice(0, 500)}`).catch(() => {});
        },
        onSummaryMessagesAccepted: (event: {
          checkpointId: string;
          keepRecentMessages: number;
          summaryChars: number;
          availableCheckpoints: number;
        }) => {
          this.updateHeartbeat().catch(() => {});
          this.appendLog(
            "system",
            `[SUMMARY_MESSAGES_APPLY_ACCEPTED] checkpoint_id=${event.checkpointId}, keep_recent_messages=${event.keepRecentMessages}, summary_chars=${event.summaryChars}, available_checkpoints=${event.availableCheckpoints}`
          ).catch(() => {});
          appendEvent(this.paths, {
            projectId: this.project.projectId,
            eventType: "SUMMARY_MESSAGES_APPLY_ACCEPTED",
            source: "agent",
            sessionId: this.request.sessionId,
            taskId: this.request.taskId,
            payload: {
              runId: this.runId,
              checkpointId: event.checkpointId,
              keepRecentMessages: event.keepRecentMessages,
              summaryChars: event.summaryChars,
              availableCheckpoints: event.availableCheckpoints
            }
          }).catch(() => {});
        },
        onSummaryMessagesApplied: (event: {
          checkpointId: string;
          keepRecentMessages: number;
          summaryChars: number;
          beforeMessages: number;
          afterMessages: number;
          compactedMessages: number;
          beforeChars: number;
          afterChars: number;
        }) => {
          this.updateHeartbeat().catch(() => {});
          this.appendLog(
            "system",
            `[SUMMARY_MESSAGES_APPLIED] checkpoint_id=${event.checkpointId}, compacted_messages=${event.compactedMessages}, chars=${event.beforeChars}->${event.afterChars}, messages=${event.beforeMessages}->${event.afterMessages}`
          ).catch(() => {});
          appendEvent(this.paths, {
            projectId: this.project.projectId,
            eventType: "SUMMARY_MESSAGES_APPLIED",
            source: "agent",
            sessionId: this.request.sessionId,
            taskId: this.request.taskId,
            payload: {
              runId: this.runId,
              checkpointId: event.checkpointId,
              keepRecentMessages: event.keepRecentMessages,
              summaryChars: event.summaryChars,
              beforeMessages: event.beforeMessages,
              afterMessages: event.afterMessages,
              compactedMessages: event.compactedMessages,
              beforeChars: event.beforeChars,
              afterChars: event.afterChars
            }
          }).catch(() => {});
        },
        onError: (error: Error) => {
          this.updateHeartbeat().catch(() => {});
          this.appendLog("stderr", `Error: ${error.message}`).catch(() => {});
        },
        onProtocolRecovery: (event: {
          kind: "toolcall_failed_injected" | "toolcall_failed_escalated";
          errorRaw: string;
          missingToolCallId?: string;
          matchedToolName?: string;
          consecutiveFailureCount: number;
          nextAction?: string;
        }) => {
          this.updateHeartbeat().catch(() => {});
          const eventType =
            event.kind === "toolcall_failed_injected"
              ? "MINIMAX_TOOLCALL_FAILED_INJECTED"
              : "MINIMAX_TOOLCALL_FAILED_ESCALATED";
          this.appendLog(
            "system",
            `[TOOLCALL_FAILED] kind=${event.kind}, missing_tool_call_id=${event.missingToolCallId ?? "(unknown)"}, tool=${event.matchedToolName ?? "(unknown)"}, count=${event.consecutiveFailureCount}`
          ).catch(() => {});
          appendEvent(this.paths, {
            projectId: this.project.projectId,
            eventType,
            source: "agent",
            sessionId: this.request.sessionId,
            taskId: this.request.taskId,
            payload: {
              runId: this.runId,
              errorRaw: event.errorRaw,
              missingToolCallId: event.missingToolCallId ?? null,
              matchedToolName: event.matchedToolName ?? null,
              consecutiveFailureCount: event.consecutiveFailureCount,
              nextAction: event.nextAction ?? null
            }
          }).catch(() => {});
        }
      };

      let result: MiniMaxRunResult;
      try {
        result = await this.agent.runWithResult({
          prompt: this.request.prompt,
          sessionId: this.request.sessionId,
          callback
        });
      } catch (firstError) {
        const firstErrorMessage = firstError instanceof Error ? firstError.message : String(firstError);

        if (isMiniMaxContextWindowExceededError(firstErrorMessage)) {
          await this.appendLog(
            "stderr",
            `MiniMax context window exceeded, attempting concise recovery retry: ${firstErrorMessage}`
          );
          await appendEvent(this.paths, {
            projectId: this.project.projectId,
            eventType: "MINIMAX_CONTEXT_WINDOW_EXCEEDED",
            source: "agent",
            payload: {
              runId: this.runId,
              error: firstErrorMessage,
              sessionId: this.request.sessionId
            },
            sessionId: this.request.sessionId,
            taskId: this.request.taskId
          });

          const recoveryPrompt = buildContextWindowRecoveryPrompt(this.request.taskId);
          try {
            result = await this.agent.runWithResult({
              prompt: recoveryPrompt,
              sessionId: this.request.sessionId,
              callback
            });
            await appendEvent(this.paths, {
              projectId: this.project.projectId,
              eventType: "MINIMAX_CONTEXT_WINDOW_RECOVERED",
              source: "agent",
              payload: {
                runId: this.runId,
                sessionId: this.request.sessionId
              },
              sessionId: this.request.sessionId,
              taskId: this.request.taskId
            });
          } catch (retryError) {
            const retryErrorMessage = retryError instanceof Error ? retryError.message : String(retryError);
            await appendEvent(this.paths, {
              projectId: this.project.projectId,
              eventType: "MINIMAX_CONTEXT_WINDOW_RECOVERY_FAILED",
              source: "agent",
              payload: {
                runId: this.runId,
                error: retryErrorMessage,
                sessionId: this.request.sessionId
              },
              sessionId: this.request.sessionId,
              taskId: this.request.taskId
            });
            throw retryError;
          }

          logger.info(`[MiniMaxRunner] context window recovery succeeded for session=${this.request.sessionId}`);
        } else if (!isMiniMaxToolCallProtocolError(firstErrorMessage)) {
          throw firstError;
        } else if (
          isMiniMaxToolResultIdNotFoundError(firstErrorMessage) ||
          firstErrorMessage.includes("[TOOLCALL_FAILED_ESCALATED]")
        ) {
          throw firstError;
        } else {
          await this.appendLog(
            "stderr",
            `MiniMax tool-call protocol error detected, attempting one recovery retry: ${firstErrorMessage}`
          );
          await appendEvent(this.paths, {
            projectId: this.project.projectId,
            eventType: "MINIMAX_TOOLCALL_PROTOCOL_ERROR",
            source: "agent",
            payload: {
              runId: this.runId,
              error: firstErrorMessage,
              sessionId: this.request.sessionId
            },
            sessionId: this.request.sessionId,
            taskId: this.request.taskId
          });

          const recoveryPrompt = buildToolCallFailRecoveryPrompt(this.request.taskId);
          await this.appendLog("system", "[TOOLCALL_FAIL] Injecting recovery context and retrying once.");

          try {
            result = await this.agent.runWithResult({
              prompt: recoveryPrompt,
              sessionId: this.request.sessionId,
              callback
            });
            await appendEvent(this.paths, {
              projectId: this.project.projectId,
              eventType: "MINIMAX_TOOLCALL_PROTOCOL_RECOVERED",
              source: "agent",
              payload: {
                runId: this.runId,
                sessionId: this.request.sessionId
              },
              sessionId: this.request.sessionId,
              taskId: this.request.taskId
            });
          } catch (retryError) {
            const retryErrorMessage = retryError instanceof Error ? retryError.message : String(retryError);
            await appendEvent(this.paths, {
              projectId: this.project.projectId,
              eventType: "MINIMAX_TOOLCALL_PROTOCOL_RECOVERY_FAILED",
              source: "agent",
              payload: {
                runId: this.runId,
                error: retryErrorMessage,
                sessionId: this.request.sessionId
              },
              sessionId: this.request.sessionId,
              taskId: this.request.taskId
            });
            throw retryError;
          }
        }
      }

      logger.info(
        `[MiniMaxRunner] runWithResult: request.sessionId=${this.request.sessionId}, request.resumeSessionId=${this.request.resumeSessionId}, result.sessionId=${result.sessionId}`
      );

      await this.appendLog("stdout", result.content);
      await appendEvent(this.paths, {
        projectId: this.project.projectId,
        eventType: "MINIMAX_RUN_FINISHED",
        source: "agent",
        payload: {
          runId: this.runId,
          dispatchId: this.request.dispatchId ?? null,
          exitCode: 0,
          timedOut: false,
          provider: "minimax",
          model,
          sessionId: result.sessionId,
          isNewSession: result.isNewSession
        },
        sessionId: this.request.sessionId,
        taskId: this.request.taskId
      });

      return {
        runId: this.runId,
        command: "MiniMax Agent",
        startedAt: this.startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        timedOut: false,
        logFile: this.getLogFile(),
        sessionId: result.sessionId,
        response: result
      };
    } catch (error) {
      const normalizedProviderError = normalizeMiniMaxRuntimeFailure(error);
      const errorMessage = normalizedProviderError
        ? normalizedProviderError.message
        : error instanceof Error
          ? error.message
          : String(error);
      await this.appendLog("stderr", `MiniMax run failed: ${errorMessage}`);
      await appendEvent(this.paths, {
        projectId: this.project.projectId,
        eventType: "MINIMAX_RUN_FINISHED",
        source: "agent",
        payload: {
          runId: this.runId,
          dispatchId: this.request.dispatchId ?? null,
          exitCode: 1,
          timedOut: false,
          provider: "minimax",
          error: errorMessage,
          ...(normalizedProviderError
            ? {
                code: normalizedProviderError.code,
                retryable: normalizedProviderError.retryable,
                next_action: normalizedProviderError.nextAction,
                details: normalizedProviderError.details ?? null
              }
            : {})
        },
        sessionId: this.request.sessionId,
        taskId: this.request.taskId
      });

      return {
        runId: this.runId,
        command: "MiniMax Agent",
        startedAt: this.startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        timedOut: false,
        logFile: this.getLogFile(),
        sessionId: this.request.sessionId,
        error: normalizedProviderError ? serializeProviderLaunchError(normalizedProviderError) : errorMessage,
        ...(normalizedProviderError ? { providerError: toProviderLaunchErrorPayload(normalizedProviderError) } : {})
      };
    } finally {
      if (this.agent) {
        await this.agent.cleanup();
      }
    }
  }
}

export async function runMiniMaxForProject(
  project: ProjectRecord,
  paths: ProjectPaths,
  request: MiniMaxRunRequest,
  settings: RuntimeSettings
): Promise<MiniMaxRunResultInternal> {
  const runner = new MiniMaxRunner(project, paths, request, settings);
  activeRunners.set(request.sessionId, runner);
  try {
    return await runner.run();
  } finally {
    activeRunners.delete(request.sessionId);
  }
}

export interface MiniMaxStartResult {
  runId: string;
  sessionId: string;
  startedAt: string;
}

export interface MiniMaxStartCallbacks {
  completionCallback?: MiniMaxCompletionCallback;
  wakeUpCallback?: MiniMaxWakeUpCallback;
}

export function startMiniMaxForProject(
  project: ProjectRecord,
  paths: ProjectPaths,
  request: MiniMaxRunRequest,
  settings: RuntimeSettings,
  callbacks?: MiniMaxStartCallbacks
): MiniMaxStartResult {
  const runner = new MiniMaxRunner(project, paths, request, settings);
  activeRunners.set(request.sessionId, runner);

  const runId = runner.getRunId();
  const startedAt = runner.getStartedAt();

  if (callbacks?.completionCallback) {
    completionCallbacks.set(runId, callbacks.completionCallback);
  }
  if (callbacks?.wakeUpCallback) {
    wakeUpCallbacks.set(runId, callbacks.wakeUpCallback);
  }

  logger.info(`[startMiniMaxForProject] sessionId=${request.sessionId}, runId=${runId}, starting async run`);

  runner
    .run()
    .then(async (result) => {
      logger.info(
        `[startMiniMaxForProject] sessionId=${request.sessionId}, runId=${runId}, completed with exitCode=${result.exitCode}`
      );
      const callback = completionCallbacks.get(runId);
      if (callback) {
        try {
          await callback(result, request.sessionId, runId);
        } catch (cbError) {
          logger.error(`[startMiniMaxForProject] callback error for sessionId=${request.sessionId}: ${cbError}`);
        }
      }
    })
    .catch(async (error) => {
      logger.error(`[startMiniMaxForProject] sessionId=${request.sessionId}, runId=${runId}, error: ${error}`);
      const callback = completionCallbacks.get(runId);
      if (callback) {
        try {
          const errorResult: MiniMaxRunResultInternal = {
            runId,
            command: "MiniMax Agent",
            startedAt,
            finishedAt: new Date().toISOString(),
            exitCode: 1,
            timedOut: false,
            logFile: runner.getLogFile(),
            sessionId: request.sessionId,
            error: error instanceof Error ? error.message : String(error)
          };
          await callback(errorResult, request.sessionId, runId);
        } catch (cbError) {
          logger.error(`[startMiniMaxForProject] callback error for sessionId=${request.sessionId}: ${cbError}`);
        }
      }
    })
    .finally(() => {
      activeRunners.delete(request.sessionId);
      completionCallbacks.delete(runId);
      wakeUpCallbacks.delete(runId);
    });

  return {
    runId,
    sessionId: request.sessionId,
    startedAt
  };
}
