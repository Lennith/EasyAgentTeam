import type express from "express";
import { BaseController } from "./base-controller.js";
import { registerWorkflowRoutes } from "./controller-routes.js";

export class WorkflowController extends BaseController {
  register(app: express.Application): void {
    registerWorkflowRoutes(app, this.context);
  }
}
