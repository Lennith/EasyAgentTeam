export interface MCPServerConfig {
  name: string;
  type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
  connectTimeout?: number;
  executeTimeout?: number;
}

export type Theme = "dark" | "vibrant" | "lively";

export interface RuntimeProviderSettings {
  codex?: {
    cliCommand?: string;
    model?: string;
    reasoningEffort?: "low" | "medium" | "high";
  };
  dpagent?: {
    cliCommand?: string;
  };
  minimax?: {
    apiKey?: string;
    apiBase?: string;
    model?: string;
    sessionDir?: string;
    mcpServers?: MCPServerConfig[];
    maxSteps?: number;
    tokenLimit?: number;
    maxOutputTokens?: number;
    shellTimeout?: number;
    shellOutputIdleTimeout?: number;
    shellMaxRunTime?: number;
    shellMaxOutputSize?: number;
  };
}

export interface RuntimeSettings {
  theme?: Theme;
  hostPlatform?: "win32" | "linux" | "darwin";
  hostPlatformLabel?: string;
  supportedShellTypes?: Array<"powershell" | "cmd" | "bash" | "sh">;
  defaultShellType?: "powershell" | "cmd" | "bash" | "sh";
  codexCliCommandDefault?: string;
  macosUntested?: boolean;
  updatedAt?: string;
  providers?: RuntimeProviderSettings;
}

export interface ModelInfo {
  vendor: string;
  model: string;
  description?: string;
}

export interface ModelsResponse {
  models: ModelInfo[];
  warnings?: string[];
  source?: "cache" | "refresh" | "fallback-mixed";
}
