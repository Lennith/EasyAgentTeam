import type express from "express";
import { BaseController } from "./base-controller.js";
import { registerProjectRuntimeRoutes } from "./controller-routes.js";

export class ProjectRuntimeController extends BaseController {
  register(app: express.Application): void {
    registerProjectRuntimeRoutes(app, this.context);
  }
}
