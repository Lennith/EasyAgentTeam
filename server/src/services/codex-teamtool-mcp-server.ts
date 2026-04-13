import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { listAgents } from "../data/repository/catalog/agent-repository.js";
import { getProject, getProjectPaths } from "../data/repository/project/runtime-repository.js";
import { listTasks } from "../data/repository/project/taskboard-repository.js";
import { createTeamTools } from "../minimax/tools/team/index.js";
import type { ToolResult } from "../minimax/types.js";
import { createMiniMaxTeamToolBridge } from "./minimax-teamtool-bridge.js";
import { createProviderRegistry } from "./provider-runtime.js";
import { buildProjectRoutingSnapshot } from "./project-routing-snapshot-service.js";
import type { CodexTeamToolContext } from "./codex-teamtool-mcp.js";
import { buildTeamToolInputSchema } from "./teamtool-schema.js";
import { createWorkflowOrchestratorService } from "./orchestrator/workflow/workflow-orchestrator.js";
import type { TeamToolBridge, TeamToolExecutionContext } from "./teamtool/types.js";
import { readWorkflowRunForApi } from "./workflow-admin-service.js";
import {
  buildWorkflowTeamToolContext,
  createWorkflowMiniMaxTeamToolBridge,
  type WorkflowMiniMaxTeamToolBridgeContext
} from "./workflow-minimax-teamtool-bridge.js";

function parseContext(argv: string[]): CodexTeamToolContext {
  const flagIndex = argv.indexOf("--context-base64");
  if (flagIndex < 0 || flagIndex + 1 >= argv.length) {
    throw new Error("Missing required --context-base64 argument");
  }
  const raw = Buffer.from(argv[flagIndex + 1], "base64").toString("utf8");
  return JSON.parse(raw) as CodexTeamToolContext;
}

function parseStructuredContent(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeTeamToolMcpResult(result: ToolResult): {
  text: string;
  isError: boolean;
  structuredContent?: Record<string, unknown>;
} {
  const text = result.success ? result.content : (result.error ?? result.content ?? "TeamTool call failed");
  const structuredContent = parseStructuredContent(text);
  return result.success
    ? { text, isError: false, ...(structuredContent ? { structuredContent } : {}) }
    : { text, isError: true, ...(structuredContent ? { structuredContent } : {}) };
}

async function buildProjectBridgeContext(
  context: Extract<CodexTeamToolContext, { scopeKind: "project" }>
): Promise<{ executionContext: TeamToolExecutionContext; bridge: TeamToolBridge }> {
  const project = await getProject(context.dataRoot, context.projectId);
  const paths = getProjectPaths(context.dataRoot, context.projectId);
  const tasks = context.activeTaskId ? await listTasks(paths, context.projectId) : [];
  const activeTask = context.activeTaskId ? (tasks.find((item) => item.taskId === context.activeTaskId) ?? null) : null;

  const executionContext: TeamToolExecutionContext = {
    dataRoot: context.dataRoot,
    project,
    paths,
    agentRole: context.agentRole,
    sessionId: context.sessionId,
    activeTaskId: context.activeTaskId,
    activeTaskTitle: activeTask?.title,
    activeParentTaskId: activeTask?.parentTaskId,
    activeRootTaskId: activeTask?.rootTaskId,
    activeRequestId: context.activeRequestId,
    parentRequestId: context.parentRequestId
  };
  return {
    executionContext,
    bridge: createMiniMaxTeamToolBridge(executionContext)
  };
}

async function buildWorkflowBridgeContext(
  context: Extract<CodexTeamToolContext, { scopeKind: "workflow" }>
): Promise<{ executionContext: TeamToolExecutionContext; bridge: TeamToolBridge }> {
  const run = await readWorkflowRunForApi(context.dataRoot, context.runId);
  if (!run) {
    throw new Error(`workflow run '${context.runId}' not found`);
  }
  const orchestrator = createWorkflowOrchestratorService(context.dataRoot, createProviderRegistry());
  const bridgeContext: WorkflowMiniMaxTeamToolBridgeContext = {
    dataRoot: context.dataRoot,
    run,
    agentRole: context.agentRole,
    sessionId: context.sessionId,
    activeTaskId: context.activeTaskId,
    activeRequestId: context.activeRequestId,
    parentRequestId: context.parentRequestId,
    applyTaskAction: async (request) =>
      (await orchestrator.applyTaskActions(context.runId, request)) as unknown as Record<string, unknown>,
    sendRunMessage: async (request) =>
      (await orchestrator.sendRunMessage({ runId: context.runId, ...request })) as unknown as Record<string, unknown>
  };
  return {
    executionContext: buildWorkflowTeamToolContext(bridgeContext),
    bridge: createWorkflowMiniMaxTeamToolBridge(bridgeContext)
  };
}

async function main(): Promise<void> {
  const context = parseContext(process.argv.slice(2));
  const built =
    context.scopeKind === "project"
      ? await buildProjectBridgeContext(context)
      : await buildWorkflowBridgeContext(context);

  const instructions =
    context.scopeKind === "project"
      ? await listAgents(context.dataRoot).then((registry) => {
          const snapshot = buildProjectRoutingSnapshot(
            built.executionContext.project,
            built.executionContext.agentRole,
            registry.map((item) => item.agentId)
          );
          return `TeamTool bridge. route_targets=${JSON.stringify(snapshot.allowedTargets.map((item) => item.agentId))}`;
        })
      : "TeamTool bridge for workflow collaboration.";

  const server = new McpServer(
    {
      name: "autodev-teamtool",
      version: "1.0.0"
    },
    {
      capabilities: { tools: {} },
      instructions
    }
  );

  for (const tool of createTeamTools({ context: built.executionContext, bridge: built.bridge })) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: buildTeamToolInputSchema(tool.parameters)
      },
      async (args) => {
        const result = await tool.execute((args ?? {}) as Record<string, unknown>);
        const normalized = normalizeTeamToolMcpResult(result);
        return {
          content: [{ type: "text", text: normalized.text }],
          isError: normalized.isError,
          ...(normalized.structuredContent ? { structuredContent: normalized.structuredContent } : {})
        };
      }
    );
  }

  await server.connect(new StdioServerTransport());
}

const isDirectExecution =
  typeof process.argv[1] === "string" && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectExecution) {
  main().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
