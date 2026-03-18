import express from "express";
import path from "node:path";
import { registerControllers } from "./controllers/index.js";
import { createProviderRegistry } from "./services/provider-runtime.js";
import { createOrchestratorService, createWorkflowOrchestratorService } from "./services/orchestrator/index.js";

export interface AppOptions {
  dataRoot?: string;
}

export function resolveDataRoot(explicitDataRoot?: string): string {
  if (explicitDataRoot) {
    return path.resolve(explicitDataRoot);
  }
  if (process.env.FRAMEWORK_DATA_ROOT) {
    return path.resolve(process.env.FRAMEWORK_DATA_ROOT);
  }
  return path.resolve(process.cwd(), "..", "data");
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const dataRoot = resolveDataRoot(options.dataRoot);
  const orchestrator = createOrchestratorService(dataRoot);
  const workflowOrchestrator = createWorkflowOrchestratorService(dataRoot);
  const providerRegistry = createProviderRegistry();

  orchestrator.start();
  workflowOrchestrator.start();

  const corsAllowList = (
    process.env.AUTO_DEV_CORS_ORIGINS ??
    "http://localhost:54174,http://127.0.0.1:54174,http://localhost:54173,http://127.0.0.1:54173"
  )
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const corsAllowSet = new Set(corsAllowList);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && corsAllowSet.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: "10mb" }));

  registerControllers(app, {
    dataRoot,
    orchestrator,
    workflowOrchestrator,
    providerRegistry
  });

  return app;
}
