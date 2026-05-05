export const API_BASE = "/api";
export const RECOVERY_CENTER_ATTEMPT_LIMIT = 5;
const AUTH_TOKEN_STORAGE_KEY = "autodev_remote_auth_token";

export class ApiAuthRequiredError extends Error {
  readonly status = 401;

  constructor(message = "Authentication required") {
    super(message);
    this.name = "ApiAuthRequiredError";
  }
}

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    } else {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
    }
  } catch {
    // ignore local storage errors
  }
}

export function clearAuthToken(): void {
  setAuthToken(null);
}

function buildHeaders(headers?: HeadersInit, json = false): Headers {
  const next = new Headers(headers);
  if (json && !next.has("Content-Type")) {
    next.set("Content-Type", "application/json");
  }
  const token = getAuthToken();
  if (token) {
    next.set("X-Auto-Dev-Auth-Token", token);
  }
  return next;
}

function handleAuthRequired(message?: string): never {
  clearAuthToken();
  window.dispatchEvent(new CustomEvent("autodev-auth-required"));
  throw new ApiAuthRequiredError(message);
}

function formatError(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    try {
      return JSON.stringify(error);
    } catch {
      return "[object Object]";
    }
  }
  return String(error);
}

export async function fetchJSON<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: buildHeaders(options?.headers, true)
  });
  const text = await response.text();
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!response.ok) {
    if (response.status === 401) {
      handleAuthRequired(formatError((data as { error?: unknown; message?: unknown }).message));
    }
    throw new Error(formatError((data as { error?: unknown }).error) ?? `HTTP ${response.status}`);
  }
  return data as T;
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: buildHeaders() });
  if (!response.ok) {
    let data: unknown = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (response.status === 401) {
      handleAuthRequired(formatError((data as { error?: unknown; message?: unknown }).message));
    }
    throw new Error(formatError((data as { error?: unknown }).error) ?? `HTTP ${response.status}`);
  }
  return response.text();
}

async function readApiError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return `HTTP ${response.status}`;
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    return formatError(parsed.error) ?? formatError(parsed.message) ?? `HTTP ${response.status}`;
  } catch {
    return text;
  }
}

export async function fetchStream(url: string, options?: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...options,
    headers: buildHeaders(options?.headers)
  });
  if (!response.ok) {
    if (response.status === 401) {
      handleAuthRequired(await readApiError(response));
    }
    throw new Error(await readApiError(response));
  }
  return response;
}
