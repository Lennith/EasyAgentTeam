import type express from "express";
import { BaseController } from "./base-controller.js";
import { registerProjectRoutes } from "./controller-routes.js";

export class ProjectController extends BaseController {
  register(app: express.Application): void {
    registerProjectRoutes(app, this.context);
  }
}
