import type { ProviderId } from "@autodev/agent-library";

export const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";
export const DEFAULT_CODEX_MODELS = [DEFAULT_CODEX_MODEL, "gpt-5"] as const;
export const DEFAULT_MINIMAX_MODEL = "MiniMax-M2.5-High-speed";

export type ProviderModelValidationCode = "PROVIDER_MODEL_MISMATCH" | "PROVIDER_MODEL_UNSUPPORTED";

export interface ProviderModelValidationSuccess {
  ok: true;
}

export interface ProviderModelValidationFailure {
  ok: false;
  code: ProviderModelValidationCode;
  message: string;
  nextAction: string;
  details: Record<string, unknown>;
}

export type ProviderModelValidationResult = ProviderModelValidationSuccess | ProviderModelValidationFailure;

function normalizeModel(raw: string | null | undefined): string {
  return (raw ?? "").trim();
}

function normalizeLower(raw: string | null | undefined): string {
  return normalizeModel(raw).toLowerCase();
}

function uniqueNormalized(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const normalized = normalizeModel(item);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

export function getDefaultProviderModels(providerId: ProviderId): string[] {
  if (providerId === "codex") {
    return [...DEFAULT_CODEX_MODELS];
  }
  return [DEFAULT_MINIMAX_MODEL];
}

export function isCodexModelName(model: string | null | undefined): boolean {
  const normalized = normalizeLower(model);
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("gpt-")) {
    return true;
  }
  return DEFAULT_CODEX_MODELS.some((item) => item.toLowerCase() === normalized);
}

export function isMiniMaxModelName(model: string | null | undefined): boolean {
  const normalized = normalizeLower(model);
  return normalized.startsWith("minimax-");
}

export function buildProviderModelMismatchNextAction(providerId: ProviderId): string {
  if (providerId === "codex") {
    return `Use a Codex model such as ${DEFAULT_CODEX_MODEL}, or switch provider to minimax.`;
  }
  return `Use a MiniMax model such as ${DEFAULT_MINIMAX_MODEL}, or switch provider to codex.`;
}

export function buildCodexUnsupportedModelNextAction(): string {
  return `Choose a Codex-supported model such as ${DEFAULT_CODEX_MODEL}, or refresh the available model list.`;
}

export function validateProviderModelCompatibility(input: {
  providerId: ProviderId;
  model?: string | null;
  availableModels?: readonly string[];
}): ProviderModelValidationResult {
  const model = normalizeModel(input.model);
  if (!model) {
    return { ok: true };
  }

  if (input.providerId === "codex") {
    if (isMiniMaxModelName(model)) {
      return {
        ok: false,
        code: "PROVIDER_MODEL_MISMATCH",
        message: `Codex provider cannot use MiniMax model '${model}'.`,
        nextAction: buildProviderModelMismatchNextAction("codex"),
        details: {
          providerId: "codex",
          model
        }
      };
    }

    const knownModels = uniqueNormalized([...(input.availableModels ?? []), ...DEFAULT_CODEX_MODELS]);
    const knownSet = new Set(knownModels.map((item) => item.toLowerCase()));
    if (knownSet.has(model.toLowerCase()) || model.toLowerCase().startsWith("gpt-")) {
      return { ok: true };
    }

    return {
      ok: false,
      code: "PROVIDER_MODEL_UNSUPPORTED",
      message: `Codex provider does not recognize model '${model}'.`,
      nextAction: buildCodexUnsupportedModelNextAction(),
      details: {
        providerId: "codex",
        model,
        knownModels
      }
    };
  }

  if (isCodexModelName(model)) {
    return {
      ok: false,
      code: "PROVIDER_MODEL_MISMATCH",
      message: `MiniMax provider cannot use Codex model '${model}'.`,
      nextAction: buildProviderModelMismatchNextAction("minimax"),
      details: {
        providerId: "minimax",
        model
      }
    };
  }

  return { ok: true };
}
