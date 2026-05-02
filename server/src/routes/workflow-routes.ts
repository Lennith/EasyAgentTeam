import type express from "express";
import type { AppRuntimeContext } from "./shared/context.js";
import { registerWorkflowAgentChatRoutes } from "./workflow/agent-chat-routes.js";
import { registerWorkflowMessageRoutes } from "./workflow/message-routes.js";
import { registerWorkflowOrchestratorRoutes } from "./workflow/orchestrator-routes.js";
import { registerWorkflowRunRoutes } from "./workflow/run-routes.js";
import { registerWorkflowSessionRoutes } from "./workflow/session-routes.js";
import { registerWorkflowTaskRoutes } from "./workflow/task-routes.js";
import { registerWorkflowTemplateRoutes } from "./workflow/template-routes.js";

export function registerWorkflowRoutes(app: express.Application, context: AppRuntimeContext): void {
  registerWorkflowOrchestratorRoutes(app, context);
  registerWorkflowTemplateRoutes(app, context);
  registerWorkflowRunRoutes(app, context);
  registerWorkflowTaskRoutes(app, context);
  registerWorkflowSessionRoutes(app, context);
  registerWorkflowMessageRoutes(app, context);
  registerWorkflowAgentChatRoutes(app, context);
}
