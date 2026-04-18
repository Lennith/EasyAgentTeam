import type { ProviderId } from "@autodev/agent-library";
import { buildCodexUnsupportedModelNextAction, validateProviderModelCompatibility } from "./provider-model-compat.js";

export type ProviderLaunchErrorCode =
  | "PROVIDER_MODEL_MISMATCH"
  | "PROVIDER_MODEL_UNSUPPORTED"
  | "PROVIDER_CLI_UNAVAILABLE"
  | "PROVIDER_UPSTREAM_TRANSIENT_ERROR";

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

export function tryDeserializeProviderLaunchError(raw: unknown): ProviderLaunchError | undefined {
  if (raw instanceof ProviderLaunchError) {
    return raw;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const text = raw.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as Partial<ProviderLaunchErrorPayload>;
    if (
      typeof parsed.code !== "string" ||
      (parsed.category !== "config" && parsed.category !== "runtime") ||
      typeof parsed.retryable !== "boolean" ||
      typeof parsed.message !== "string" ||
      typeof parsed.next_action !== "string"
    ) {
      return undefined;
    }
    return new ProviderLaunchError({
      code: parsed.code as ProviderLaunchErrorCode,
      category: parsed.category,
      retryable: parsed.retryable,
      message: parsed.message,
      nextAction: parsed.next_action,
      details:
        parsed.details && typeof parsed.details === "object" ? (parsed.details as Record<string, unknown>) : undefined
    });
  } catch {
    return undefined;
  }
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

const MINIMAX_TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504, 529]);
const MINIMAX_TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET"
]);

function readUnknownString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const direct = record.status;
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return direct;
  }
  const statusCode = record.statusCode;
  if (typeof statusCode === "number" && Number.isFinite(statusCode)) {
    return statusCode;
  }
  const response = record.response;
  if (response && typeof response === "object") {
    const nestedStatus = (response as Record<string, unknown>).status;
    if (typeof nestedStatus === "number" && Number.isFinite(nestedStatus)) {
      return nestedStatus;
    }
  }
  const cause = record.cause;
  if (cause && typeof cause === "object") {
    const nestedStatus = (cause as Record<string, unknown>).status;
    if (typeof nestedStatus === "number" && Number.isFinite(nestedStatus)) {
      return nestedStatus;
    }
  }
  return undefined;
}

function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  return (
    readUnknownString(record.code) ?? readUnknownString((record.cause as Record<string, unknown> | undefined)?.code)
  );
}

function buildMiniMaxTransientMessage(status: number | undefined): string {
  if (typeof status === "number") {
    return `MiniMax upstream returned transient status ${status}.`;
  }
  return "MiniMax upstream returned a transient runtime error.";
}

function isMiniMaxTransientMessage(text: string): boolean {
  return (
    text.includes("overloaded_error") ||
    text.includes("rate limit") ||
    text.includes("rate_limit") ||
    text.includes("too many requests") ||
    text.includes("temporarily unavailable") ||
    text.includes("service unavailable") ||
    text.includes("gateway timeout") ||
    text.includes("connection reset") ||
    text.includes("connect timeout") ||
    text.includes("connection timeout") ||
    text.includes("read timeout") ||
    text.includes("request timed out") ||
    text.includes("socket hang up")
  );
}

export function normalizeMiniMaxRuntimeFailure(error: unknown): ProviderLaunchError | undefined {
  const status = readNumericStatus(error);
  const code = readErrorCode(error);
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalizedMessage = message.toLowerCase();

  if (typeof status === "number" && MINIMAX_TRANSIENT_STATUS_CODES.has(status)) {
    return new ProviderLaunchError({
      code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
      category: "runtime",
      retryable: true,
      message: buildMiniMaxTransientMessage(status),
      nextAction: "Wait for cooldown and retry the same task/message dispatch.",
      details: {
        providerId: "minimax",
        status
      }
    });
  }

  if (code && MINIMAX_TRANSIENT_NETWORK_CODES.has(code)) {
    return new ProviderLaunchError({
      code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
      category: "runtime",
      retryable: true,
      message: "MiniMax upstream connection failed with a transient network error.",
      nextAction: "Wait for cooldown and retry the same task/message dispatch.",
      details: {
        providerId: "minimax",
        code
      }
    });
  }

  if (!normalizedMessage) {
    return undefined;
  }

  if (!isMiniMaxTransientMessage(normalizedMessage)) {
    return undefined;
  }

  return new ProviderLaunchError({
    code: "PROVIDER_UPSTREAM_TRANSIENT_ERROR",
    category: "runtime",
    retryable: true,
    message: buildMiniMaxTransientMessage(status),
    nextAction: "Wait for cooldown and retry the same task/message dispatch.",
    details: {
      providerId: "minimax",
      ...(typeof status === "number" ? { status } : {}),
      ...(code ? { code } : {})
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
