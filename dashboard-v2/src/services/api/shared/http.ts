export const API_BASE = "/api";
export const RECOVERY_CENTER_ATTEMPT_LIMIT = 5;

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
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options
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
    throw new Error(formatError((data as { error?: unknown }).error) ?? `HTTP ${response.status}`);
  }
  return data as T;
}

export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    let data: unknown = {};
    try {
      data = await response.json();
    } catch {
      data = {};
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
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(await readApiError(response));
  }
  return response;
}
