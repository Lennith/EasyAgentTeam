import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectRecord } from "../domain/models.js";
import { ensureDirectory } from "../utils/file-utils.js";

export interface AgentScriptBootstrapResult {
  createdFiles: string[];
  skippedFiles: string[];
}

export const AGENT_TOOLS_DIR = "TeamTools";
export const AGENT_TOOLCHAIN_VERSION = "teamtools-v4";

export class TeamToolsTemplateError extends Error {
  constructor(
    message: string,
    public readonly code: "TEAMTOOLS_TEMPLATE_NOT_FOUND"
  ) {
    super(message);
  }
}

async function cleanupLegacyScriptArtifacts(workspacePath: string): Promise<void> {
  const legacyRelativePaths = [
    "autodev_handoff.ps1",
    "autodev_clarify.ps1",
    "autodev_route_targets.ps1",
    "autodev_lock.ps1",
    "devtools",
    "DevTools"
  ];
  for (const legacyPath of legacyRelativePaths) {
    const absolutePath = path.join(workspacePath, ...legacyPath.split("/"));
    try {
      await fs.rm(absolutePath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export async function ensureProjectAgentScripts(project: ProjectRecord): Promise<AgentScriptBootstrapResult> {
  const result: AgentScriptBootstrapResult = {
    createdFiles: [],
    skippedFiles: []
  };

  await ensureDirectory(project.workspacePath);
  await cleanupLegacyScriptArtifacts(project.workspacePath);
  result.skippedFiles.push("TeamTools copy skipped (ToolCall direct mode)");

  return result;
}
