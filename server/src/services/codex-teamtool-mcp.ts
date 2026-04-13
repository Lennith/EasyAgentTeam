import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TeamToolExecutionContext } from "./teamtool/types.js";
import { TEAMTOOL_MCP_SERVER_KEY } from "./teamtool-contract.js";

export interface ProjectCodexTeamToolContext {
  scopeKind: "project";
  dataRoot: string;
  projectId: string;
  workspaceRoot: string;
  agentRole: string;
  sessionId: string;
  activeTaskId?: string;
  activeRequestId?: string;
  parentRequestId?: string;
}

export interface WorkflowCodexTeamToolContext {
  scopeKind: "workflow";
  dataRoot: string;
  runId: string;
  workspaceRoot: string;
  agentRole: string;
  sessionId: string;
  activeTaskId?: string;
  activeRequestId?: string;
  parentRequestId?: string;
}

export type CodexTeamToolContext = ProjectCodexTeamToolContext | WorkflowCodexTeamToolContext;

function encodeContext(context: CodexTeamToolContext): string {
  return Buffer.from(JSON.stringify(context), "utf8").toString("base64");
}

function toTomlLiteralString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function toTomlLiteralArray(values: string[]): string {
  return `[${values.map((value) => toTomlLiteralString(value)).join(",")}]`;
}

const moduleRequire = createRequire(import.meta.url);

function resolveTsxImportPath(): string {
  return pathToFileURL(moduleRequire.resolve("tsx")).href;
}

function resolveCodexTeamToolServerEntry(): { command: string; argsPrefix: string[] } {
  const sourcePath = fileURLToPath(new URL("./codex-teamtool-mcp-server.ts", import.meta.url));
  if (sourcePath.endsWith(".ts")) {
    return {
      command: process.execPath,
      argsPrefix: ["--import", resolveTsxImportPath(), sourcePath]
    };
  }

  return {
    command: process.execPath,
    argsPrefix: [sourcePath]
  };
}

export function buildCodexTeamToolServerSpec(context: CodexTeamToolContext): { command: string; args: string[] } {
  const entry = resolveCodexTeamToolServerEntry();
  return {
    command: entry.command,
    args: [...entry.argsPrefix, "--context-base64", encodeContext(context)]
  };
}

export function buildCodexTeamToolConfigArgs(context: CodexTeamToolContext): string[] {
  const spec = buildCodexTeamToolServerSpec(context);
  return [
    "-c",
    `mcp_servers.${TEAMTOOL_MCP_SERVER_KEY}.command=${toTomlLiteralString(spec.command)}`,
    "-c",
    `mcp_servers.${TEAMTOOL_MCP_SERVER_KEY}.args=${toTomlLiteralArray(spec.args)}`
  ];
}

export function buildProjectCodexTeamToolContext(context: TeamToolExecutionContext): ProjectCodexTeamToolContext {
  return {
    scopeKind: "project",
    dataRoot: context.dataRoot,
    projectId: context.project.projectId,
    workspaceRoot: context.project.workspacePath,
    agentRole: context.agentRole,
    sessionId: context.sessionId,
    activeTaskId: context.activeTaskId,
    activeRequestId: context.activeRequestId,
    parentRequestId: context.parentRequestId
  };
}
