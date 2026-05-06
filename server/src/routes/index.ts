import type express from "express";
import type { AppRuntimeContext } from "./shared/context.js";
import { registerCatalogRoutes } from "./catalog-routes.js";
import { registerApiErrorMiddleware } from "./error-middleware.js";
import { registerProjectRoutes } from "./project-routes.js";
import { registerSystemRoutes } from "./system-routes.js";
import { registerTriggerRoutes } from "./trigger-routes.js";
import { registerWorkflowRecoveryRoutes } from "./workflow-recovery-routes.js";
import { registerWorkflowRoutes } from "./workflow-routes.js";

export function registerRoutes(app: express.Application, context: AppRuntimeContext): void {
  registerSystemRoutes(app, context);
  registerTriggerRoutes(app, context);
  registerWorkflowRoutes(app, context);
  registerWorkflowRecoveryRoutes(app, context);
  registerCatalogRoutes(app, context);
  registerProjectRoutes(app, context);
  registerApiErrorMiddleware(app);
}
