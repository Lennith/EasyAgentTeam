import type express from "express";
import { AgentTeamSkillController } from "./agent-team-skill-controller.js";
import { ProjectController } from "./project-controller.js";
import { ProjectRuntimeController } from "./project-runtime-controller.js";
import { SystemController } from "./system-controller.js";
import type { AppRuntimeContext } from "./types.js";
import { WorkflowController } from "./workflow-controller.js";
import { registerApiErrorMiddleware } from "./controller-routes.js";

export function registerControllers(app: express.Application, context: AppRuntimeContext): void {
  new SystemController(context).register(app);
  new WorkflowController(context).register(app);
  new AgentTeamSkillController(context).register(app);
  new ProjectController(context).register(app);
  new ProjectRuntimeController(context).register(app);
  registerApiErrorMiddleware(app);
}
