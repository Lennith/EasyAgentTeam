import type { ProviderId } from "@autodev/agent-library";
import { BASE_PROMPT_TEXT } from "./agent-prompt-service.js";
import type { HostPlatform } from "../runtime-platform.js";
import { getRuntimePlatformCapabilities } from "../runtime-platform.js";

const PROVIDER_BASELINES: Record<ProviderId, string> = {
  codex: "Provider policy: Codex CLI runtime. Prefer deterministic, tool-driven execution.",
  trae: "Provider policy: Trae CLI runtime. Keep actions explicit and auditable.",
  minimax:
    "Provider policy: MiniMax runtime. Keep tool-call ordering valid and avoid stale tool_result reuse. Use summary_messages when context noise is high."
};

const CONTEXT_BASELINES: Record<string, string> = {
  project_dispatch:
    "Context: project orchestrator dispatch. Prioritize assigned task execution and task-action reporting.",
  project_agent_chat: "Context: project agent chat. Answer user prompt while preserving task/action constraints.",
  workflow_dispatch: "Context: workflow orchestrator dispatch. Respect phase dependencies and report to phase task.",
  workflow_agent_chat: "Context: workflow agent chat. Keep responses aligned with workflow runtime constraints."
};

export interface PromptComposeInput {
  providerId: ProviderId;
  hostPlatform?: HostPlatform | NodeJS.Platform;
  role?: string;
  rolePrompt?: string;
  contextKind?: string;
  contextOverride?: string;
  runtimeConstraints?: string[];
  skillSegments?: string[];
}

export interface PromptComposeResult {
  systemPrompt: string;
  segments: string[];
}

function normalizeSegment(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function composeSystemPrompt(input: PromptComposeInput): PromptComposeResult {
  const segments: string[] = [];
  const global = normalizeSegment(BASE_PROMPT_TEXT);
  if (global) {
    segments.push(global);
  }
  const provider = normalizeSegment(PROVIDER_BASELINES[input.providerId]);
  if (provider) {
    segments.push(provider);
  }
  const runtime = normalizeSegment(getRuntimePlatformCapabilities(input.hostPlatform).promptBaseline);
  if (runtime) {
    segments.push(runtime);
  }
  if (input.role && input.role.trim().length > 0) {
    segments.push(`Role: ${input.role.trim()}`);
  }
  const rolePrompt = normalizeSegment(input.rolePrompt);
  if (rolePrompt) {
    segments.push(`Role prompt:\n${rolePrompt}`);
  }
  if (input.contextKind && CONTEXT_BASELINES[input.contextKind]) {
    segments.push(CONTEXT_BASELINES[input.contextKind]);
  }
  const contextOverride = normalizeSegment(input.contextOverride);
  if (contextOverride) {
    segments.push(`Context override:\n${contextOverride}`);
  }
  if (input.runtimeConstraints && input.runtimeConstraints.length > 0) {
    const lines = input.runtimeConstraints
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => `- ${item}`);
    if (lines.length > 0) {
      segments.push(["Runtime constraints:", ...lines].join("\n"));
    }
  }
  if (input.skillSegments && input.skillSegments.length > 0) {
    for (const skill of input.skillSegments) {
      const segment = normalizeSegment(skill);
      if (segment) {
        segments.push(segment);
      }
    }
  }
  return {
    systemPrompt: segments.join("\n\n"),
    segments
  };
}
