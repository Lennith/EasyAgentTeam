import type express from "express";
import type { AppRuntimeContext } from "./types.js";

export interface Controller {
  register(app: express.Application): void;
}

export abstract class BaseController implements Controller {
  constructor(protected readonly context: AppRuntimeContext) {}

  abstract register(app: express.Application): void;
}
