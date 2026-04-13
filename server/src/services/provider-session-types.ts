import type { CodexTeamToolContext } from "./codex-teamtool-mcp.js";
import type { TeamToolBridge, TeamToolExecutionContext } from "./teamtool/types.js";
import type { ProviderId } from "@autodev/agent-library";

export interface ProviderObservationEvent {
  providerId: ProviderId;
  kind: string;
  role?: string;
  providerSessionId?: string;
  step?: number;
  details?: Record<string, unknown>;
}

export interface ProviderSessionCallback {
  onThinking?: (thinking: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  onToolResult?: (name: string, result: { success: boolean; content: string; error?: string }) => void;
  onStep?: (step: number, maxSteps: number) => void;
  onMessage?: (role: string, content: string) => void;
  onError?: (error: Error) => void;
  onSummaryMessagesAccepted?: (event: {
    checkpointId: string;
    keepRecentMessages: number;
    summaryChars: number;
    availableCheckpoints: number;
  }) => void;
  onSummaryMessagesApplied?: (event: {
    checkpointId: string;
    keepRecentMessages: number;
    summaryChars: number;
    beforeMessages: number;
    afterMessages: number;
    compactedMessages: number;
    beforeChars: number;
    afterChars: number;
  }) => void;
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
  onProviderObservation?: (event: ProviderObservationEvent) => void | Promise<void>;
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
}

export interface ProviderSessionRunInput {
  prompt: string;
  providerSessionId: string;
  workspaceDir: string;
  workspaceRoot: string;
  model?: string;
  reasoningEffort?: string;
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
  codexTeamToolContext?: CodexTeamToolContext;
  sessionDirFallback: string;
  apiBaseFallback: string;
  modelFallback: string;
  callback?: ProviderSessionCallback;
}
