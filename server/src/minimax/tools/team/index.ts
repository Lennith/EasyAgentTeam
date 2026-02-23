import type { Tool } from "../Tool.js";
import { DiscussCloseTool } from "./DiscussCloseTool.js";
import { DiscussReplyTool } from "./DiscussReplyTool.js";
import { DiscussRequestTool } from "./DiscussRequestTool.js";
import { LockManageTool } from "./LockManageTool.js";
import { RouteTargetsTool } from "./RouteTargetsTool.js";
import { TaskCreateAssignTool } from "./TaskCreateAssignTool.js";
import { TaskReportBlockTool } from "./TaskReportBlockTool.js";
import { TaskReportDoneTool } from "./TaskReportDoneTool.js";
import { TaskReportInProgressTool } from "./TaskReportInProgressTool.js";
import type { TeamToolBridge, TeamToolExecutionContext } from "./types.js";

export interface TeamToolsOptions {
  context: TeamToolExecutionContext;
  bridge: TeamToolBridge;
}

export function createTeamTools(options: TeamToolsOptions): Tool[] {
  const { context, bridge } = options;
  return [
    new TaskCreateAssignTool(context, bridge),
    new TaskReportInProgressTool(context, bridge),
    new TaskReportDoneTool(context, bridge),
    new TaskReportBlockTool(context, bridge),
    new DiscussRequestTool(context, bridge),
    new DiscussReplyTool(context, bridge),
    new DiscussCloseTool(context, bridge),
    new RouteTargetsTool(context, bridge),
    new LockManageTool(context, bridge)
  ];
}

export { TeamTool } from "./TeamTool.js";
export type { TeamToolBridge, TeamToolExecutionContext, TeamToolErrorPayload } from "./types.js";
