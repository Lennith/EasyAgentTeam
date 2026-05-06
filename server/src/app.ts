import express from "express";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeSettings } from "./data/repository/system/runtime-settings-repository.js";
import { registerRoutes } from "./routes/index.js";
import { extractRemoteAuthToken, validateRemoteAuthToken } from "./services/remote-auth-service.js";
import { createProviderRegistry } from "./services/provider-runtime.js";
import {
  createOrchestratorService,
  createWorkflowOrchestratorService,
  createWorkflowRecurringDispatcherService
} from "./services/orchestrator/index.js";
import { createTriggerRuntimeService } from "./services/trigger/index.js";

export interface AppOptions {
  dataRoot?: string;
  autoStartLoops?: boolean;
}

export interface AppRuntimeControls {
  start(): void;
  stop(): void;
  orchestrator: ReturnType<typeof createOrchestratorService>;
  workflowOrchestrator: ReturnType<typeof createWorkflowOrchestratorService>;
  workflowRecurringDispatcher: ReturnType<typeof createWorkflowRecurringDispatcherService>;
  triggerRuntime: ReturnType<typeof createTriggerRuntimeService>;
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDir, "..", "..");

export function resolveDataRoot(explicitDataRoot?: string): string {
  if (explicitDataRoot) {
    return path.resolve(explicitDataRoot);
  }
  if (process.env.FRAMEWORK_DATA_ROOT) {
    return path.resolve(process.env.FRAMEWORK_DATA_ROOT);
  }
  return path.join(repositoryRoot, "data");
}

export function createApp(options: AppOptions = {}) {
  const app = express();
  const dataRoot = resolveDataRoot(options.dataRoot);
  const providerRegistry = createProviderRegistry();
  const orchestrator = createOrchestratorService(dataRoot, providerRegistry);
  const workflowOrchestrator = createWorkflowOrchestratorService(dataRoot, providerRegistry);
  const workflowRecurringDispatcher = createWorkflowRecurringDispatcherService(dataRoot, workflowOrchestrator);
  const triggerRuntime = createTriggerRuntimeService(dataRoot, workflowOrchestrator);
  let loopsStarted = false;
  const runtimeControls: AppRuntimeControls = {
    orchestrator,
    workflowOrchestrator,
    workflowRecurringDispatcher,
    triggerRuntime,
    start: () => {
      if (loopsStarted) {
        return;
      }
      orchestrator.start();
      workflowOrchestrator.start();
      workflowRecurringDispatcher.start();
      triggerRuntime.start();
      loopsStarted = true;
    },
    stop: () => {
      if (!loopsStarted) {
        return;
      }
      triggerRuntime.stop();
      workflowRecurringDispatcher.stop();
      workflowOrchestrator.stop();
      orchestrator.stop();
      loopsStarted = false;
    }
  };

  if (options.autoStartLoops !== false) {
    runtimeControls.start();
  }
  app.locals.runtimeControls = runtimeControls;

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
      res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Auto-Dev-Auth-Token");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: "10mb" }));

  app.use(async (req, res, next) => {
    if (
      req.method === "OPTIONS" ||
      !req.path.startsWith("/api/") ||
      req.path === "/api/auth/login" ||
      req.path === "/api/auth/status"
    ) {
      next();
      return;
    }
    try {
      const settings = await getRuntimeSettings(dataRoot);
      if (validateRemoteAuthToken(settings, extractRemoteAuthToken(req))) {
        next();
        return;
      }
      res.status(401).json({
        error_code: "AUTH_REQUIRED",
        error: "AUTH_REQUIRED",
        message: "Remote login password is required."
      });
    } catch (error) {
      next(error);
    }
  });

  registerRoutes(app, {
    dataRoot,
    orchestrator,
    workflowOrchestrator,
    triggerRuntime,
    providerRegistry
  });

  return app;
}

export function getAppRuntimeControls(app: express.Application): AppRuntimeControls | undefined {
  return app.locals.runtimeControls as AppRuntimeControls | undefined;
}

export async function stopAppRuntime(app: express.Application, server?: Server): Promise<void> {
  getAppRuntimeControls(app)?.stop();
  if (!server || !server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}
