import type express from "express";
import { translateApiError } from "./api-error-translator.js";

export function registerApiErrorMiddleware(app: express.Application): void {
  app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    translateApiError(error, req, res);
  });
}
