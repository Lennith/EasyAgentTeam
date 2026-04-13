import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectPaths } from "../domain/models.js";
import { getProjectPaths } from "../data/repository/project/runtime-repository.js";
import { getWorkflowRunRuntimePaths } from "../data/repository/workflow/runtime-repository.js";
import type { CodexTeamToolContext } from "./codex-teamtool-mcp.js";

const DEFAULT_CODEX_RUNTIME_CONFIG = [
  "# Auto-generated isolated Codex runtime home for AutoDev.",
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"'
].join("\n");
const COPIED_AUTH_FILENAMES = ["auth.json"] as const;

function sanitizeScopeSegment(value: string | undefined): string {
  const normalized = (value ?? "").trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return normalized.length > 0 ? normalized : "default";
}

function buildScopedHome(baseDir: string, scopeKey: string | undefined): string {
  return path.join(baseDir, sanitizeScopeSegment(scopeKey));
}

export function buildProjectCodexRuntimeHome(paths: ProjectPaths, scopeKey?: string): string {
  return buildScopedHome(path.join(paths.collabDir, "codex-home"), scopeKey);
}

export function buildWorkflowCodexRuntimeHome(dataRoot: string, runId: string, scopeKey?: string): string {
  const runtimePaths = getWorkflowRunRuntimePaths(dataRoot, runId);
  return buildScopedHome(path.join(runtimePaths.runRootDir, "codex-home"), scopeKey);
}

export interface BuildSessionCodexRuntimeHomeInput {
  sessionDirFallback: string;
  workspaceRoot: string;
  role?: string;
  codexTeamToolContext?: CodexTeamToolContext;
}

export function buildSessionCodexRuntimeHome(input: BuildSessionCodexRuntimeHomeInput): string {
  const scopeKey = input.role ?? input.codexTeamToolContext?.agentRole;
  const context = input.codexTeamToolContext;
  if (context?.scopeKind === "project") {
    return buildProjectCodexRuntimeHome(getProjectPaths(context.dataRoot, context.projectId), scopeKey);
  }
  if (context?.scopeKind === "workflow") {
    return buildWorkflowCodexRuntimeHome(context.dataRoot, context.runId, scopeKey);
  }
  const fallbackRoot =
    input.workspaceRoot.trim().length > 0 ? input.workspaceRoot : path.resolve(input.sessionDirFallback, "..", "..");
  return buildScopedHome(path.join(fallbackRoot, ".codex-runtime"), scopeKey);
}

function resolveGlobalCodexHome(): string {
  const override = process.env.AUTO_DEV_CODEX_AUTH_SOURCE_DIR?.trim();
  if (override && override.length > 0) {
    return override;
  }
  return path.join(os.homedir(), ".codex");
}

async function syncAuthArtifacts(codexHome: string): Promise<void> {
  const globalCodexHome = resolveGlobalCodexHome();
  for (const filename of COPIED_AUTH_FILENAMES) {
    const source = path.join(globalCodexHome, filename);
    const target = path.join(codexHome, filename);
    try {
      await fs.copyFile(source, target);
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

export async function ensureCodexRuntimeHome(codexHome: string): Promise<string> {
  await fs.mkdir(codexHome, { recursive: true });
  await syncAuthArtifacts(codexHome);
  const configPath = path.join(codexHome, "config.toml");
  try {
    const existing = await fs.readFile(configPath, "utf8");
    if (existing.trim() === DEFAULT_CODEX_RUNTIME_CONFIG.trim()) {
      return codexHome;
    }
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code !== "ENOENT") {
      throw error;
    }
  }
  await fs.writeFile(configPath, `${DEFAULT_CODEX_RUNTIME_CONFIG}\n`, "utf8");
  return codexHome;
}
