import type express from "express";
import { AuthLoginRequestSchema, RuntimeSettingsPatchRequestSchema } from "@autodev/agent-library";
import { BASE_PROMPT_TEXT, BASE_PROMPT_VERSION } from "../services/agent-prompt-service.js";
import { createModelManagerService } from "../services/model-manager-service.js";
import { getProjectPathsForId } from "../services/project-admin-service.js";
import {
  getRuntimeSettingsForApi,
  patchRuntimeSettingsForApi,
  readRuntimeSettings
} from "../services/runtime-settings-service.js";
import type { AppRuntimeContext } from "./shared/context.js";
import { readStringField, sendApiError } from "./shared/http.js";
import {
  extractRemoteAuthToken,
  issueRemoteAuthToken,
  isRemotePasswordEnabled,
  validateRemoteAuthToken,
  verifyRemotePassword
} from "../services/remote-auth-service.js";

const RETIRED_SETTINGS_FIELDS = [
  "codex_cli_command",
  "codexCliCommand",
  "minimax_api_key",
  "minimaxApiKey",
  "minimax_api_base",
  "minimaxApiBase",
  "minimax_model",
  "minimaxModel",
  "minimax_session_dir",
  "minimaxSessionDir",
  "minimax_mcp_servers",
  "minimaxMcpServers",
  "minimax_max_steps",
  "minimaxMaxSteps",
  "minimax_token_limit",
  "minimaxTokenLimit",
  "minimax_max_output_tokens",
  "minimaxMaxOutputTokens",
  "minimax_shell_timeout",
  "minimaxShellTimeout",
  "minimax_shell_output_idle_timeout",
  "minimaxShellOutputIdleTimeout",
  "minimax_shell_max_run_time",
  "minimaxShellMaxRunTime",
  "minimax_shell_max_output_size",
  "minimaxShellMaxOutputSize"
];

export function registerSystemRoutes(app: express.Application, context: AppRuntimeContext): void {
  const { dataRoot, orchestrator } = context;
  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "autodevelopframework-server",
      time: new Date().toISOString()
    });
  });

  app.get("/api/project-templates", (_req, res) => {
    res.json({
      items: [
        { templateId: "none", name: "No Template", description: "Create empty collaboration project" },
        {
          templateId: "web_mvp",
          name: "Web MVP",
          description: "Starter shape for web MVP workflow (PM -> planner -> dev -> qa)"
        },
        {
          templateId: "repo_doc_flow",
          name: "Repo Doc Flow",
          description: "Scaffold PM/planner/devleader/dev documentation workflow in workspace"
        }
      ],
      total: 3
    });
  });
  app.get("/api/prompts/base", (_req, res) => {
    res.json({
      version: BASE_PROMPT_VERSION,
      prompt: BASE_PROMPT_TEXT
    });
  });

  app.get("/api/settings", async (_req, res, next) => {
    try {
      res.status(200).json(await getRuntimeSettingsForApi(dataRoot));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/auth/status", async (req, res, next) => {
    try {
      const settings = await readRuntimeSettings(dataRoot);
      const enabled = isRemotePasswordEnabled(settings);
      res.status(200).json({
        remote_password_enabled: enabled,
        authenticated: !enabled || validateRemoteAuthToken(settings, extractRemoteAuthToken(req))
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/auth/login", async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
      const parsed = AuthLoginRequestSchema.safeParse(body);
      const password =
        parsed.success && parsed.data.password
          ? parsed.data.password
          : readStringField(body, ["password", "remote_password", "remotePassword"]);
      const settings = await readRuntimeSettings(dataRoot);
      if (!isRemotePasswordEnabled(settings)) {
        res.status(200).json({
          token: null,
          remote_password_enabled: false
        });
        return;
      }
      if (!password || !verifyRemotePassword(settings, password)) {
        sendApiError(res, 401, "AUTH_INVALID_PASSWORD", "Remote login password is invalid.");
        return;
      }
      const token = issueRemoteAuthToken(settings);
      res.status(200).json({
        token,
        remote_password_enabled: true
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/settings", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const retiredField = RETIRED_SETTINGS_FIELDS.find((key) => Object.prototype.hasOwnProperty.call(body, key));
      if (retiredField) {
        sendApiError(
          res,
          400,
          "SETTINGS_FIELD_RETIRED",
          `Runtime settings field '${retiredField}' is retired. Use providers.codex, providers.dpagent, or providers.minimax.`
        );
        return;
      }
      const themeRaw = readStringField(body, ["theme"]);
      if (themeRaw !== undefined && themeRaw !== "dark" && themeRaw !== "vibrant" && themeRaw !== "lively") {
        sendApiError(res, 400, "SETTINGS_INPUT_INVALID", "theme must be dark, vibrant, or lively");
        return;
      }
      const parsed = RuntimeSettingsPatchRequestSchema.safeParse(body);
      if (!parsed.success) {
        sendApiError(res, 400, "SETTINGS_INPUT_INVALID", "settings payload is invalid");
        return;
      }
      const updated = await patchRuntimeSettingsForApi(dataRoot, parsed.data);
      res.status(200).json(updated);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/orchestrator/status", async (_req, res, next) => {
    try {
      const status = await orchestrator.getStatus();
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/models", async (req, res, next) => {
    try {
      const projectId = typeof req.query.project_id === "string" ? req.query.project_id.trim() : "";
      const refresh = typeof req.query.refresh === "string" && req.query.refresh === "true";

      if (!projectId) {
        const runtimeSettings = await readRuntimeSettings(dataRoot);
        const minimaxModel = runtimeSettings.providers.minimax.model?.trim() || "MiniMax-M2.5-High-speed";
        const defaultModels = [
          { vendor: "codex", model: "gpt-5.3-codex", description: "Codex recommended model" },
          { vendor: "codex", model: "gpt-5", description: "GPT-5 model" },
          { vendor: "dpagent", model: "dpagent-config", description: "DPAgent model from external config.yaml" },
          { vendor: "minimax", model: minimaxModel, description: `MiniMax model: ${minimaxModel}` }
        ];
        res.status(200).json({
          models: defaultModels,
          total: defaultModels.length,
          warnings: ["No project_id provided, returning default models"],
          source: "fallback",
          updatedAt: new Date().toISOString()
        });
        return;
      }

      const paths = getProjectPathsForId(dataRoot, projectId);
      const modelManager = createModelManagerService(paths, dataRoot);
      const result = refresh ? await modelManager.refreshModels() : await modelManager.getAvailableModels();
      res.status(200).json({
        models: result.models,
        total: result.models.length,
        warnings: result.warnings,
        source: result.source,
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      next(error);
    }
  });
}
