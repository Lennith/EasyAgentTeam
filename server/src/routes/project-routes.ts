import type express from "express";
import type { AppRuntimeContext } from "./shared/context.js";
import { registerProjectMetaRoutes } from "./project-meta-routes.js";
import { registerProjectRuntimeRoutes } from "./project-runtime-routes.js";
import { registerProjectTaskRoutes } from "./project-task-routes.js";

export function registerProjectRoutes(app: express.Application, context: AppRuntimeContext): void {
  registerProjectMetaRoutes(app, context);
  registerProjectTaskRoutes(app, context);
  registerProjectRuntimeRoutes(app, context);
}
