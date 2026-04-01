import path from "node:path";

const DEFAULT_AUTO_DEV_MANAGER_URL = "http://127.0.0.1:43123";

export function buildOrchestratorAgentWorkspaceDir(workspaceRoot: string, role: string): string {
  return path.join(workspaceRoot, "Agents", role);
}

export function buildOrchestratorAgentProgressFile(workspaceRoot: string, role: string): string {
  return path.join(buildOrchestratorAgentWorkspaceDir(workspaceRoot, role), "progress.md");
}

export function buildOrchestratorMinimaxSessionDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".minimax", "sessions");
}

export function resolveOrchestratorProviderSessionId(sessionId: string, providerSessionId?: string | null): string {
  return providerSessionId?.trim() || sessionId;
}

export function resolveOrchestratorManagerUrl(): string {
  return process.env.AUTO_DEV_MANAGER_URL ?? DEFAULT_AUTO_DEV_MANAGER_URL;
}
