import type { ProviderId } from "@autodev/agent-library";
import { buildCodexUnsupportedModelNextAction, validateProviderModelCompatibility } from "./provider-model-compat.js";

export type ProviderLaunchErrorCode =
  | "PROVIDER_MODEL_MISMATCH"
  | "PROVIDER_MODEL_UNSUPPORTED"
  | "PROVIDER_CLI_UNAVAILABLE";

export type ProviderLaunchErrorCategory = "config" | "runtime";

export interface ProviderLaunchErrorPayload {
  code: ProviderLaunchErrorCode;
  category: ProviderLaunchErrorCategory;
  retryable: boolean;
  message: string;
  next_action: string;
  details?: Record<string, unknown>;
}

export class ProviderLaunchError extends Error {
  public readonly code: ProviderLaunchErrorCode;
  public readonly category: ProviderLaunchErrorCategory;
  public readonly retryable: boolean;
  public readonly nextAction: string;
  public readonly details?: Record<string, unknown>;

  constructor(input: {
    code: ProviderLaunchErrorCode;
    category: ProviderLaunchErrorCategory;
    retryable: boolean;
    message: string;
    nextAction: string;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "ProviderLaunchError";
    this.code = input.code;
    this.category = input.category;
    this.retryable = input.retryable;
    this.nextAction = input.nextAction;
    this.details = input.details;
  }
}

export function isProviderLaunchError(error: unknown): error is ProviderLaunchError {
  return error instanceof ProviderLaunchError;
}

export function toProviderLaunchErrorPayload(error: ProviderLaunchError): ProviderLaunchErrorPayload {
  return {
    code: error.code,
    category: error.category,
    retryable: error.retryable,
    message: error.message,
    next_action: error.nextAction,
    ...(error.details ? { details: error.details } : {})
  };
}

export function serializeProviderLaunchError(error: ProviderLaunchError): string {
  return JSON.stringify(toProviderLaunchErrorPayload(error));
}

export function assertProviderModelLaunchable(input: {
  providerId: ProviderId;
  model?: string | null;
  availableModels?: readonly string[];
}): void {
  const result = validateProviderModelCompatibility(input);
  if (result.ok) {
    return;
  }
  throw new ProviderLaunchError({
    code: result.code,
    category: "config",
    retryable: false,
    message: result.message,
    nextAction: result.nextAction,
    details: result.details
  });
}

export function createProviderCliUnavailableError(providerId: ProviderId, command: string): ProviderLaunchError {
  return new ProviderLaunchError({
    code: "PROVIDER_CLI_UNAVAILABLE",
    category: "config",
    retryable: false,
    message: `${providerId} CLI command '${command}' is unavailable.`,
    nextAction: `Configure settings.${providerId}CliCommand to a working ${providerId} CLI command and retry.`,
    details: {
      providerId,
      command
    }
  });
}

function matchesUnsupportedModelOutput(text: string): boolean {
  return (
    /unknown model/i.test(text) ||
    /unsupported model/i.test(text) ||
    /model .* not supported/i.test(text) ||
    /invalid value .*--model/i.test(text)
  );
}

export function normalizeCodexLaunchFailure(input: {
  model?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: unknown;
  command?: string | null;
}): ProviderLaunchError | undefined {
  const command = (input.command ?? "codex").trim() || "codex";
  const namedError = input.error as NodeJS.ErrnoException | undefined;
  if (namedError?.code === "ENOENT") {
    return createProviderCliUnavailableError("codex", command);
  }

  const combined = [input.stderr ?? "", input.stdout ?? ""].join("\n").trim();
  if (!combined) {
    return undefined;
  }

  if (!matchesUnsupportedModelOutput(combined)) {
    return undefined;
  }

  const validation = validateProviderModelCompatibility({
    providerId: "codex",
    model: input.model
  });
  if (!validation.ok && validation.code === "PROVIDER_MODEL_MISMATCH") {
    return new ProviderLaunchError({
      code: "PROVIDER_MODEL_MISMATCH",
      category: "config",
      retryable: false,
      message: validation.message,
      nextAction: validation.nextAction,
      details: {
        ...validation.details,
        command
      }
    });
  }

  const model = (input.model ?? "").trim();
  return new ProviderLaunchError({
    code: "PROVIDER_MODEL_UNSUPPORTED",
    category: "config",
    retryable: false,
    message: model
      ? `Codex provider does not support model '${model}'.`
      : "Codex provider rejected the configured model.",
    nextAction: buildCodexUnsupportedModelNextAction(),
    details: {
      providerId: "codex",
      model,
      command
    }
  });
}

export function createProviderModelApiError(
  providerId: ProviderId,
  model?: string | null
): {
  code: "AGENT_MODEL_PROVIDER_MISMATCH";
  message: string;
  nextAction: string;
} | null {
  const validation = validateProviderModelCompatibility({
    providerId,
    model
  });
  if (validation.ok) {
    return null;
  }
  return {
    code: "AGENT_MODEL_PROVIDER_MISMATCH",
    message: validation.message,
    nextAction: validation.nextAction
  };
}
