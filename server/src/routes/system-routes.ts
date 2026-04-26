import type express from "express";
import { BASE_PROMPT_TEXT, BASE_PROMPT_VERSION } from "../services/agent-prompt-service.js";
import { createModelManagerService } from "../services/model-manager-service.js";
import { getProjectPathsForId } from "../services/project-admin-service.js";
import {
  getRuntimeSettingsForApi,
  patchRuntimeSettingsForApi,
  readRuntimeSettings
} from "../services/runtime-settings-service.js";
import type { AppRuntimeContext } from "./shared/context.js";
import { readNullableStringPatch, readStringField } from "./shared/http.js";

function readObjectField(body: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = body[key];
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readNumberField(body: Record<string, unknown>, snakeKey: string, camelKey: string): number | undefined {
  return typeof body[snakeKey] === "number"
    ? (body[snakeKey] as number)
    : typeof body[camelKey] === "number"
      ? (body[camelKey] as number)
      : undefined;
}

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

  app.patch("/api/settings", async (req, res, next) => {
    try {
      const body = req.body as Record<string, unknown>;
      const themeRaw = readStringField(body, ["theme"]);
      const theme = themeRaw === "dark" || themeRaw === "vibrant" || themeRaw === "lively" ? themeRaw : undefined;
      const minimaxApiKeyPatch = readNullableStringPatch(body, ["minimax_api_key", "minimaxApiKey"]);
      const minimaxApiBasePatch = readNullableStringPatch(body, ["minimax_api_base", "minimaxApiBase"]);
      const providersRaw = readObjectField(body, "providers");
      const codexProviderRaw = providersRaw ? readObjectField(providersRaw, "codex") : undefined;
      const minimaxProviderRaw = providersRaw ? readObjectField(providersRaw, "minimax") : undefined;
      const providerMiniMaxApiKeyPatch = minimaxProviderRaw
        ? readNullableStringPatch(minimaxProviderRaw, ["api_key", "apiKey"])
        : undefined;
      const providerMiniMaxApiBasePatch = minimaxProviderRaw
        ? readNullableStringPatch(minimaxProviderRaw, ["api_base", "apiBase"])
        : undefined;
      const updated = await patchRuntimeSettingsForApi(dataRoot, {
        codexCliCommand: readStringField(body, ["codex_cli_command", "codexCliCommand"]),
        theme,
        ...(minimaxApiKeyPatch !== undefined ? { minimaxApiKey: minimaxApiKeyPatch } : {}),
        ...(minimaxApiBasePatch !== undefined ? { minimaxApiBase: minimaxApiBasePatch } : {}),
        minimaxModel: readStringField(body, ["minimax_model", "minimaxModel"]),
        minimaxSessionDir: readStringField(body, ["minimax_session_dir", "minimaxSessionDir"]),
        minimaxMcpServers: body.minimax_mcp_servers ?? (body.minimaxMcpServers as any),
        minimaxMaxSteps:
          typeof body.minimax_max_steps === "number"
            ? body.minimax_max_steps
            : typeof body.minimaxMaxSteps === "number"
              ? body.minimaxMaxSteps
              : undefined,
        minimaxTokenLimit:
          typeof body.minimax_token_limit === "number"
            ? body.minimax_token_limit
            : typeof body.minimaxTokenLimit === "number"
              ? body.minimaxTokenLimit
              : undefined,
        minimaxMaxOutputTokens:
          typeof body.minimax_max_output_tokens === "number"
            ? body.minimax_max_output_tokens
            : typeof body.minimaxMaxOutputTokens === "number"
              ? body.minimaxMaxOutputTokens
              : undefined,
        providers: providersRaw
          ? {
              ...(codexProviderRaw
                ? {
                    codex: {
                      cliCommand: readStringField(codexProviderRaw, ["cli_command", "cliCommand"]),
                      model: readStringField(codexProviderRaw, ["model"]),
                      reasoningEffort: readStringField(codexProviderRaw, ["reasoning_effort", "reasoningEffort"]) as
                        | "low"
                        | "medium"
                        | "high"
                        | undefined
                    }
                  }
                : {}),
              ...(minimaxProviderRaw
                ? {
                    minimax: {
                      ...(providerMiniMaxApiKeyPatch !== undefined ? { apiKey: providerMiniMaxApiKeyPatch } : {}),
                      ...(providerMiniMaxApiBasePatch !== undefined ? { apiBase: providerMiniMaxApiBasePatch } : {}),
                      model: readStringField(minimaxProviderRaw, ["model"]),
                      sessionDir: readStringField(minimaxProviderRaw, ["session_dir", "sessionDir"]),
                      mcpServers: minimaxProviderRaw.mcp_servers ?? (minimaxProviderRaw.mcpServers as any),
                      maxSteps: readNumberField(minimaxProviderRaw, "max_steps", "maxSteps"),
                      tokenLimit: readNumberField(minimaxProviderRaw, "token_limit", "tokenLimit"),
                      maxOutputTokens: readNumberField(minimaxProviderRaw, "max_output_tokens", "maxOutputTokens"),
                      shellTimeout: readNumberField(minimaxProviderRaw, "shell_timeout", "shellTimeout"),
                      shellOutputIdleTimeout: readNumberField(
                        minimaxProviderRaw,
                        "shell_output_idle_timeout",
                        "shellOutputIdleTimeout"
                      ),
                      shellMaxRunTime: readNumberField(minimaxProviderRaw, "shell_max_run_time", "shellMaxRunTime"),
                      shellMaxOutputSize: readNumberField(
                        minimaxProviderRaw,
                        "shell_max_output_size",
                        "shellMaxOutputSize"
                      )
                    }
                  }
                : {})
            }
          : undefined
      });
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
        const minimaxModel = runtimeSettings.minimaxModel?.trim() || "MiniMax-M2.5-High-speed";
        const defaultModels = [
          { vendor: "codex", model: "gpt-5.3-codex", description: "Codex recommended model" },
          { vendor: "codex", model: "gpt-5", description: "GPT-5 model" },
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
