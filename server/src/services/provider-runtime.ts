import { runModelForProject, type ModelRunResult } from "./codex-runner.js";
import { buildProjectCodexTeamToolContext, type ProjectCodexTeamToolContext } from "./codex-teamtool-mcp.js";
import { CodexSessionRuntime } from "./codex-session-runtime.js";
import {
  cancelMiniMaxRunner,
  isMiniMaxRunnerActive,
  startMiniMaxForProject,
  type MiniMaxRunResultInternal,
  type MiniMaxStartCallbacks
} from "./minimax-runner.js";
import { createMiniMaxAgent, type MiniMaxAgent, type MiniMaxRunResult } from "../minimax/index.js";
import type { RuntimeSettings } from "../data/repository/system/runtime-settings-repository.js";
import type { ProjectPaths, ProjectRecord } from "../domain/models.js";
import type { ProviderId } from "@autodev/agent-library";
import type { ProviderSessionRunInput } from "./provider-session-types.js";
import { composeSystemPrompt } from "./prompt-composer.js";
import { resolveSkillPromptSegments } from "./skill-catalog.js";
import { getDefaultShellType } from "../runtime-platform.js";
import { normalizeMiniMaxRuntimeFailure } from "./provider-launch-error.js";
import { DEFAULT_MINIMAX_MODEL } from "./provider-model-compat.js";

type ProjectSyncRunResult = ModelRunResult | MiniMaxRunResultInternal;

export interface ProjectDispatchInput {
  sessionId: string;
  prompt: string;
  dataRoot?: string;
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

export type MiniMaxSessionRunInput = ProviderSessionRunInput;

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

class CodexProviderRuntime implements ProviderRuntime {
  public readonly providerId: ProviderId = "codex";
  private readonly sessionRuntime = new CodexSessionRuntime();

  async launchProjectDispatch(
    project: ProjectRecord,
    paths: ProjectPaths,
    input: ProjectDispatchInput,
    settings: RuntimeSettings
  ): Promise<ProjectDispatchLaunchResult> {
    const codexTeamToolContext: ProjectCodexTeamToolContext | undefined =
      input.dataRoot && input.agentRole
        ? buildProjectCodexTeamToolContext({
            dataRoot: input.dataRoot,
            project,
            paths,
            agentRole: input.agentRole,
            sessionId: input.sessionId,
            activeTaskId: input.taskId,
            activeTaskTitle: input.activeTaskTitle,
            activeParentTaskId: input.activeParentTaskId,
            activeRootTaskId: input.activeRootTaskId,
            activeRequestId: input.activeRequestId,
            parentRequestId: input.parentRequestId
          })
        : undefined;
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
        cli_tool: "codex",
        model_command: input.modelCommand,
        model_params: input.modelParams,
        resume_session_id: input.resumeSessionId,
        codex_teamtool_context: codexTeamToolContext
      },
      settings
    );
    return {
      mode: "sync",
      result
    };
  }

  async runSessionWithTools(settings: RuntimeSettings, input: MiniMaxSessionRunInput): Promise<MiniMaxRunResult> {
    return await this.sessionRuntime.runSessionWithTools(settings, input);
  }

  cancelSession(sessionId: string): boolean {
    return this.sessionRuntime.cancelSession(sessionId);
  }

  isSessionActive(sessionId: string): boolean {
    return this.sessionRuntime.isSessionActive(sessionId);
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
    const profile = settings.providers?.minimax;
    const apiKey = profile?.apiKey ?? settings.minimaxApiKey;
    if (!apiKey) {
      throw new Error("MiniMax API key is not configured. Please configure it in Settings.");
    }
    const model = resolveMiniMaxRuntimeModel(settings, input);

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
        apiKey,
        apiBase: profile?.apiBase ?? settings.minimaxApiBase ?? input.apiBaseFallback,
        model,
        workspaceDir: input.workspaceDir,
        sessionDir: profile?.sessionDir ?? settings.minimaxSessionDir ?? input.sessionDirFallback,
        maxSteps: profile?.maxSteps ?? settings.minimaxMaxSteps ?? 200,
        tokenLimit: profile?.tokenLimit ?? settings.minimaxTokenLimit ?? 180000,
        maxOutputTokens: profile?.maxOutputTokens ?? settings.minimaxMaxOutputTokens ?? 16384,
        enableFileTools: true,
        enableShell: true,
        enableNote: true,
        shellType: getDefaultShellType(),
        shellTimeout: profile?.shellTimeout ?? settings.minimaxShellTimeout ?? 30000,
        shellOutputIdleTimeout: profile?.shellOutputIdleTimeout ?? settings.minimaxShellOutputIdleTimeout ?? 60000,
        shellMaxRunTime: profile?.shellMaxRunTime ?? settings.minimaxShellMaxRunTime ?? 600000,
        shellMaxOutputSize: profile?.shellMaxOutputSize ?? settings.minimaxShellMaxOutputSize ?? 52428800,
        mcpEnabled: ((profile?.mcpServers ?? settings.minimaxMcpServers)?.length ?? 0) > 0,
        mcpServers: profile?.mcpServers ?? settings.minimaxMcpServers ?? [],
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
      try {
        return await agent.runWithResult({
          prompt: input.prompt,
          sessionId: input.providerSessionId,
          callback: input.callback
        });
      } catch (error) {
        const normalized = normalizeMiniMaxRuntimeFailure(error);
        if (normalized) {
          throw normalized;
        }
        throw error;
      }
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

export function resolveMiniMaxRuntimeModel(
  settings: RuntimeSettings,
  input: Pick<MiniMaxSessionRunInput, "model" | "modelFallback">
): string {
  return (
    input.model ??
    settings.providers?.minimax?.model ??
    settings.minimaxModel ??
    input.modelFallback ??
    DEFAULT_MINIMAX_MODEL
  );
}

export class ProviderRegistry {
  private readonly runtimes = new Map<ProviderId, ProviderRuntime>();

  constructor() {
    this.register(new CodexProviderRuntime());
    this.register(new MiniMaxProviderRuntime());
  }

  register(runtime: ProviderRuntime): void {
    this.runtimes.set(runtime.providerId, runtime);
  }

  resolve(providerId: string | undefined | null): ProviderRuntime {
    const normalized = (providerId ?? "minimax").trim().toLowerCase();
    const resolvedProviderId = normalized === "trae" ? "minimax" : normalized;
    if (resolvedProviderId === "codex" || resolvedProviderId === "minimax") {
      const runtime = this.runtimes.get(resolvedProviderId);
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
  if (providerIdRaw === "trae") {
    return "minimax";
  }
  if (providerIdRaw === "codex" || providerIdRaw === "minimax") {
    return providerIdRaw;
  }
  return fallback;
}
