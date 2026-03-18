import type express from "express";
import { BaseController } from "./base-controller.js";
import { registerSystemRoutes } from "./controller-routes.js";

export class SystemController extends BaseController {
  register(app: express.Application): void {
    registerSystemRoutes(app, this.context);
  }
}
