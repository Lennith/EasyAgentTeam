import { runModelForProject, type ModelRunResult } from "./codex-runner.js";
import {
  cancelMiniMaxRunner,
  isMiniMaxRunnerActive,
  startMiniMaxForProject,
  type MiniMaxRunResultInternal,
  type MiniMaxStartCallbacks
} from "./minimax-runner.js";
import { createMiniMaxAgent, type MiniMaxAgent, type MiniMaxRunResult } from "../minimax/index.js";
import type { RuntimeSettings } from "../data/runtime-settings-store.js";
import type { ProjectPaths, ProjectRecord } from "../domain/models.js";
import type { TeamToolBridge, TeamToolExecutionContext } from "../minimax/tools/team/types.js";
import type { ProviderId } from "@autodev/agent-library";
import { composeSystemPrompt } from "./prompt-composer.js";
import { resolveSkillPromptSegments } from "./skill-catalog.js";
import { getDefaultShellType } from "../runtime-platform.js";

type ProjectSyncRunResult = ModelRunResult | MiniMaxRunResultInternal;

export interface ProjectDispatchInput {
  sessionId: string;
  prompt: string;
  dispatchId?: string;
  taskId?: string;
  activeTaskTitle?: string;
  activeParentTaskId?: string;
  activeRootTaskId?: string;
  activeRequestId?: string;
  parentRequestId?: string;
  agentRole?: string;
  modelCommand?: string;
  modelParams?: Record<string, unknown>;
  resumeSessionId?: string;
}

export type ProjectDispatchLaunchResult =
  | {
      mode: "sync";
      result: ProjectSyncRunResult;
    }
  | {
      mode: "async";
      runId: string;
      startedAt: string;
      sessionId: string;
    };

export interface MiniMaxSessionRunInput {
  prompt: string;
  providerSessionId: string;
  workspaceDir: string;
  workspaceRoot: string;
  role?: string;
  rolePrompt?: string;
  contextKind?: string;
  contextOverride?: string;
  runtimeConstraints?: string[];
  skillManifestPath?: string;
  skillSegments?: string[];
  skillIds?: string[];
  requiredSkillIds?: string[];
  env?: Record<string, string>;
  teamToolContext?: TeamToolExecutionContext;
  teamToolBridge?: TeamToolBridge;
  sessionDirFallback: string;
  apiBaseFallback: string;
  modelFallback: string;
  callback?: {
    onThinking?: (thinking: string) => void;
    onToolCall?: (name: string, args: Record<string, unknown>) => void;
    onToolResult?: (name: string, result: { success: boolean; content: string; error?: string }) => void;
    onStep?: (step: number, maxSteps: number) => void;
    onMessage?: (role: string, content: string) => void;
    onError?: (error: Error) => void;
    onMaxTokensRecovery?: (event: {
      observedAt: string;
      step: number;
      attempt: number;
      maxAttempts: number;
      recovered: boolean;
      finishReason: "max_tokens";
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      preCompressMessageCount: number;
      preCompressChars: number;
      postCompressMessageCount: number;
      postCompressChars: number;
      compactedToolCallChains: number;
      compactedToolMessages: number;
      compressionMode: "llm_compressor" | "deterministic_trim" | "none";
      compressionError?: string;
      continuationInjected: boolean;
      maxTokensSnapshotPath?: string | null;
    }) => void | Promise<void>;
    onComplete?: (
      result: string,
      finishReason?: string,
      meta?: {
        finishReason?: string;
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
        step: number;
        recoveredFromMaxTokens?: boolean;
        maxTokensRecoveryAttempt?: number;
        maxTokensSnapshotPath?: string | null;
      }
    ) => void;
  };
}

export interface ProviderRuntime {
  providerId: ProviderId;
  launchProjectDispatch(
    project: ProjectRecord,
    paths: ProjectPaths,
    input: ProjectDispatchInput,
    settings: RuntimeSettings,
    callbacks?: MiniMaxStartCallbacks
  ): Promise<ProjectDispatchLaunchResult>;
  runSessionWithTools?(settings: RuntimeSettings, input: MiniMaxSessionRunInput): Promise<MiniMaxRunResult>;
  cancelSession(sessionId: string): boolean;
  isSessionActive(sessionId: string): boolean;
}

class CliProviderRuntime implements ProviderRuntime {
  constructor(public readonly providerId: ProviderId) {}

  async launchProjectDispatch(
    project: ProjectRecord,
    paths: ProjectPaths,
    input: ProjectDispatchInput,
    settings: RuntimeSettings
  ): Promise<ProjectDispatchLaunchResult> {
    const result = await runModelForProject(
      project,
      paths,
      {
        session_id: input.sessionId,
        prompt: input.prompt,
        dispatch_id: input.dispatchId,
        task_id: input.taskId,
        active_task_title: input.activeTaskTitle,
        active_parent_task_id: input.activeParentTaskId,
        active_root_task_id: input.activeRootTaskId,
        active_request_id: input.activeRequestId,
        parent_request_id: input.parentRequestId,
        agent_role: input.agentRole,
        cli_tool: this.providerId,
        model_command: input.modelCommand,
        model_params: input.modelParams,
        resume_session_id: input.resumeSessionId
      },
      settings
    );
    return {
      mode: "sync",
      result
    };
  }

  cancelSession(_sessionId: string): boolean {
    return false;
  }

  isSessionActive(_sessionId: string): boolean {
    return false;
  }
}

class MiniMaxProviderRuntime implements ProviderRuntime {
  public readonly providerId: ProviderId = "minimax";
  private readonly activeToolSessions = new Map<string, MiniMaxAgent>();

  async launchProjectDispatch(
    project: ProjectRecord,
    paths: ProjectPaths,
    input: ProjectDispatchInput,
    settings: RuntimeSettings,
    callbacks?: MiniMaxStartCallbacks
  ): Promise<ProjectDispatchLaunchResult> {
    const startResult = startMiniMaxForProject(
      project,
      paths,
      {
        sessionId: input.sessionId,
        prompt: input.prompt,
        dispatchId: input.dispatchId,
        taskId: input.taskId,
        activeTaskTitle: input.activeTaskTitle,
        activeParentTaskId: input.activeParentTaskId,
        activeRootTaskId: input.activeRootTaskId,
        activeRequestId: input.activeRequestId,
        parentRequestId: input.parentRequestId,
        agentRole: input.agentRole,
        cliTool: "minimax",
        model: typeof input.modelParams?.model === "string" ? input.modelParams.model : undefined,
        modelParams: input.modelParams
      },
      settings,
      callbacks
    );
    return {
      mode: "async",
      runId: startResult.runId,
      startedAt: startResult.startedAt,
      sessionId: startResult.sessionId
    };
  }

  async runSessionWithTools(settings: RuntimeSettings, input: MiniMaxSessionRunInput): Promise<MiniMaxRunResult> {
    if (!settings.minimaxApiKey) {
      throw new Error("MiniMax API key is not configured. Please configure it in Settings.");
    }

    const skillPrompt = resolveSkillPromptSegments({
      manifestPath: input.skillManifestPath ?? process.env.AUTO_DEV_SKILL_MANIFEST,
      providerId: "minimax",
      contextKind: input.contextKind,
      requestedSkillIds: input.skillIds,
      requiredSkillIds: input.requiredSkillIds
    });
    if (skillPrompt.missingRequiredSkillIds.length > 0) {
      throw new Error(`SKILL_REQUIRED_MISSING: ${skillPrompt.missingRequiredSkillIds.join(", ")}`);
    }
    const injectedSkillSegments = [...(input.skillSegments ?? []), ...skillPrompt.segments];
    const promptCompose = composeSystemPrompt({
      providerId: "minimax",
      hostPlatform: process.platform,
      role: input.role,
      rolePrompt: input.rolePrompt,
      contextKind: input.contextKind,
      contextOverride: input.contextOverride,
      runtimeConstraints: input.runtimeConstraints,
      skillSegments: injectedSkillSegments
    });

    const sessionKey = input.providerSessionId.trim();
    const agent = createMiniMaxAgent({
      config: {
        apiKey: settings.minimaxApiKey ?? "",
        apiBase: settings.minimaxApiBase ?? input.apiBaseFallback,
        model: settings.minimaxModel ?? input.modelFallback,
        workspaceDir: input.workspaceDir,
        sessionDir: settings.minimaxSessionDir ?? input.sessionDirFallback,
        maxSteps: settings.minimaxMaxSteps ?? 200,
        tokenLimit: settings.minimaxTokenLimit ?? 180000,
        maxOutputTokens: settings.minimaxMaxOutputTokens ?? 16384,
        enableFileTools: true,
        enableShell: true,
        enableNote: true,
        shellType: getDefaultShellType(),
        shellTimeout: settings.minimaxShellTimeout ?? 30000,
        shellOutputIdleTimeout: settings.minimaxShellOutputIdleTimeout ?? 60000,
        shellMaxRunTime: settings.minimaxShellMaxRunTime ?? 600000,
        shellMaxOutputSize: settings.minimaxShellMaxOutputSize ?? 52428800,
        mcpEnabled: (settings.minimaxMcpServers?.length ?? 0) > 0,
        mcpServers: settings.minimaxMcpServers ?? [],
        mcpConnectTimeout: 30000,
        mcpExecuteTimeout: 60000,
        systemPrompt: promptCompose.systemPrompt,
        additionalWritableDirs: [input.workspaceRoot],
        teamToolContext: input.teamToolContext,
        teamToolBridge: input.teamToolBridge,
        env: input.env
      }
    });

    this.activeToolSessions.set(sessionKey, agent);
    try {
      return await agent.runWithResult({
        prompt: input.prompt,
        sessionId: input.providerSessionId,
        callback: input.callback
      });
    } finally {
      const active = this.activeToolSessions.get(sessionKey);
      if (active === agent) {
        this.activeToolSessions.delete(sessionKey);
      }
    }
  }

  cancelSession(sessionId: string): boolean {
    const activeToolSession = this.activeToolSessions.get(sessionId);
    if (activeToolSession) {
      activeToolSession.cancel();
      return true;
    }
    return cancelMiniMaxRunner(sessionId);
  }

  isSessionActive(sessionId: string): boolean {
    if (this.activeToolSessions.has(sessionId)) {
      return true;
    }
    return isMiniMaxRunnerActive(sessionId);
  }
}

export class ProviderRegistry {
  private readonly runtimes = new Map<ProviderId, ProviderRuntime>();

  constructor() {
    this.register(new CliProviderRuntime("codex"));
    this.register(new CliProviderRuntime("trae"));
    this.register(new MiniMaxProviderRuntime());
  }

  register(runtime: ProviderRuntime): void {
    this.runtimes.set(runtime.providerId, runtime);
  }

  resolve(providerId: string | undefined | null): ProviderRuntime {
    const normalized = (providerId ?? "minimax").trim().toLowerCase();
    if (normalized === "codex" || normalized === "trae" || normalized === "minimax") {
      const runtime = this.runtimes.get(normalized);
      if (runtime) {
        return runtime;
      }
    }
    throw new Error(`SESSION_PROVIDER_NOT_SUPPORTED: provider '${providerId ?? ""}'`);
  }

  async launchProjectDispatch(
    providerId: string | undefined,
    project: ProjectRecord,
    paths: ProjectPaths,
    input: ProjectDispatchInput,
    settings: RuntimeSettings,
    callbacks?: MiniMaxStartCallbacks
  ): Promise<ProjectDispatchLaunchResult> {
    const runtime = this.resolve(providerId);
    return await runtime.launchProjectDispatch(project, paths, input, settings, callbacks);
  }

  async runSessionWithTools(
    providerId: string | undefined,
    settings: RuntimeSettings,
    input: MiniMaxSessionRunInput
  ): Promise<MiniMaxRunResult> {
    const runtime = this.resolve(providerId);
    if (!runtime.runSessionWithTools) {
      throw new Error(
        `PROVIDER_RUNTIME_NOT_SUPPORTED: provider '${runtime.providerId}' does not support session tools`
      );
    }
    return await runtime.runSessionWithTools(settings, input);
  }

  cancelSession(providerId: string | undefined, sessionId: string): boolean {
    const runtime = this.resolve(providerId);
    return runtime.cancelSession(sessionId);
  }

  isSessionActive(providerId: string | undefined, sessionId: string): boolean {
    const runtime = this.resolve(providerId);
    return runtime.isSessionActive(sessionId);
  }
}

export function createProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry();
}

export function resolveSessionProviderId(
  project: unknown,
  role: string | undefined,
  fallback: ProviderId = "minimax"
): ProviderId {
  const normalizedRole = (role ?? "").trim();
  if (!normalizedRole || !project || typeof project !== "object") {
    return fallback;
  }
  const modelConfigs = (project as { agentModelConfigs?: Record<string, { provider_id?: string }> }).agentModelConfigs;
  if (!modelConfigs) {
    return fallback;
  }
  const modelConfig = modelConfigs[normalizedRole];
  const providerIdRaw = modelConfig?.provider_id;
  if (providerIdRaw === "codex" || providerIdRaw === "trae" || providerIdRaw === "minimax") {
    return providerIdRaw;
  }
  return fallback;
}
