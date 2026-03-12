import type { TeamToolBridge, TeamToolExecutionContext } from "../minimax/tools/team/types.js";
import { createMiniMaxTeamToolBridge } from "./minimax-teamtool-bridge.js";
import {
  buildWorkflowTeamToolContext,
  createWorkflowMiniMaxTeamToolBridge,
  type WorkflowMiniMaxTeamToolBridgeContext
} from "./workflow-minimax-teamtool-bridge.js";

export interface ToolInjectionPayload {
  teamToolContext?: TeamToolExecutionContext;
  teamToolBridge?: TeamToolBridge;
}

export interface ToolExecutionContextAdapter {
  resolve(): ToolInjectionPayload;
}

export interface ToolInjector {
  build(adapter?: ToolExecutionContextAdapter | null): ToolInjectionPayload;
}

export const DefaultToolInjector: ToolInjector = {
  build(adapter?: ToolExecutionContextAdapter | null): ToolInjectionPayload {
    if (!adapter) {
      return {};
    }
    return adapter.resolve();
  }
};

export function createProjectToolExecutionAdapter(context: TeamToolExecutionContext): ToolExecutionContextAdapter {
  return {
    resolve(): ToolInjectionPayload {
      return {
        teamToolContext: context,
        teamToolBridge: createMiniMaxTeamToolBridge(context)
      };
    }
  };
}

export function createWorkflowToolExecutionAdapter(
  context: WorkflowMiniMaxTeamToolBridgeContext
): ToolExecutionContextAdapter {
  return {
    resolve(): ToolInjectionPayload {
      return {
        teamToolContext: buildWorkflowTeamToolContext(context),
        teamToolBridge: createWorkflowMiniMaxTeamToolBridge(context)
      };
    }
  };
}
