import type express from "express";
import {
  TriggerConfigCreateRequestSchema,
  TriggerConfigPatchRequestSchema,
  TriggerPluginImportRequestSchema,
  TriggerSessionBindingResetRequestSchema
} from "@autodev/agent-library";
import type { AppRuntimeContext } from "./shared/context.js";
import { sendApiError } from "./shared/http.js";

function toPluginApi(plugin: {
  pluginId: string;
  name: string;
  description?: string;
  entry: string;
  sourcePath: string;
  packagePath: string;
  hasCompletionHook: boolean;
  createdAt: string;
  updatedAt: string;
}) {
  return plugin;
}

function toTriggerApi(trigger: {
  triggerId: string;
  pluginId: string;
  enabled: boolean;
  intervalSeconds: number;
  workflowTemplateId: string;
  workspacePath: string;
  defaultVariables?: Record<string, string>;
  hookTimeoutMs: number;
  sessionMode: "fresh" | "reuse_provider_session";
  lastCheckedAt?: string;
  nextCheckAt?: string;
  lastFireId?: string;
  createdAt: string;
  updatedAt: string;
}) {
  return trigger;
}

function sendTriggerError(res: express.Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const pluginNotFound = /plugin '.+' not found/.test(message);
  const notFound = /not found/.test(message);
  const exists = /already exists/.test(message);
  sendApiError(
    res,
    notFound ? 404 : exists ? 409 : 400,
    pluginNotFound
      ? "TRIGGER_PLUGIN_NOT_FOUND"
      : notFound
        ? "TRIGGER_NOT_FOUND"
        : exists
          ? "TRIGGER_EXISTS"
          : "TRIGGER_INPUT_INVALID",
    message
  );
}

export function registerTriggerRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { triggerRuntime } = context;
  if (!triggerRuntime) {
    throw new Error("trigger runtime is required for trigger routes");
  }

  app.get("/api/trigger-plugins", async (_req, res, next) => {
    try {
      const items = await triggerRuntime.listPlugins();
      res.status(200).json({ items: items.map(toPluginApi), total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/trigger-plugins/import", async (req, res, next) => {
    try {
      const parsed = TriggerPluginImportRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendApiError(res, 400, "TRIGGER_PLUGIN_IMPORT_INVALID", "source is required");
        return;
      }
      const plugin = await triggerRuntime.importPlugin(parsed.data);
      res.status(200).json({ plugin: toPluginApi(plugin) });
    } catch (error) {
      sendTriggerError(res, error);
    }
  });

  app.get("/api/triggers", async (_req, res, next) => {
    try {
      const items = await triggerRuntime.listTriggers();
      res.status(200).json({ items: items.map(toTriggerApi), total: items.length });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/triggers", async (req, res, next) => {
    try {
      const parsed = TriggerConfigCreateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendApiError(
          res,
          400,
          "TRIGGER_INPUT_INVALID",
          "trigger_id, plugin_id, workflow_template_id, and workspace_path are required"
        );
        return;
      }
      const trigger = await triggerRuntime.createTrigger(parsed.data);
      res.status(201).json(toTriggerApi(trigger));
    } catch (error) {
      sendTriggerError(res, error);
    }
  });

  app.patch("/api/triggers/:trigger_id", async (req, res, next) => {
    try {
      const parsed = TriggerConfigPatchRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        sendApiError(res, 400, "TRIGGER_INPUT_INVALID", "trigger patch payload is invalid");
        return;
      }
      const trigger = await triggerRuntime.patchTrigger(req.params.trigger_id, parsed.data);
      res.status(200).json(toTriggerApi(trigger));
    } catch (error) {
      sendTriggerError(res, error);
    }
  });

  app.delete("/api/triggers/:trigger_id", async (req, res, next) => {
    try {
      const removed = await triggerRuntime.deleteTrigger(req.params.trigger_id);
      res.status(200).json(toTriggerApi(removed));
    } catch (error) {
      sendTriggerError(res, error);
    }
  });

  app.post("/api/triggers/:trigger_id/test", async (req, res, next) => {
    try {
      const result = await triggerRuntime.testTrigger(req.params.trigger_id);
      res.status(200).json(result);
    } catch (error) {
      sendTriggerError(res, error);
    }
  });

  app.get("/api/triggers/:trigger_id/runs", async (req, res, next) => {
    try {
      const items = await triggerRuntime.listRuns(req.params.trigger_id);
      res.status(200).json({ items, total: items.length });
    } catch (error) {
      sendTriggerError(res, error);
    }
  });

  app.get("/api/triggers/:trigger_id/session-bindings", async (req, res, next) => {
    try {
      const items = await triggerRuntime.listSessionBindings(req.params.trigger_id);
      res.status(200).json({ items, total: items.length });
    } catch (error) {
      sendTriggerError(res, error);
    }
  });

  app.post("/api/triggers/:trigger_id/session-bindings/reset", async (req, res, next) => {
    try {
      const parsed = TriggerSessionBindingResetRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        sendApiError(res, 400, "TRIGGER_INPUT_INVALID", "session binding reset payload is invalid");
        return;
      }
      const removed = await triggerRuntime.resetSessionBindings(req.params.trigger_id, parsed.data);
      res.status(200).json({ removed, removedCount: removed.length });
    } catch (error) {
      sendTriggerError(res, error);
    }
  });
}
