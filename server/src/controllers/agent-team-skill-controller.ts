import type express from "express";
import { BaseController } from "./base-controller.js";
import { registerAgentTeamSkillRoutes } from "./controller-routes.js";

export class AgentTeamSkillController extends BaseController {
  register(app: express.Application): void {
    registerAgentTeamSkillRoutes(app, this.context);
  }
}
