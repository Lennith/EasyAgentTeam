import { spawn } from "node:child_process";
import path from "node:path";
import type { ProjectPaths } from "../domain/models.js";
import { readJsonFile, writeJsonFile } from "../utils/file-utils.js";
import { getRuntimeSettings, type RuntimeSettings } from "../data/repository/system/runtime-settings-repository.js";
import { DEFAULT_CODEX_MODELS, DEFAULT_MINIMAX_MODEL } from "./provider-model-compat.js";

export interface ModelInfo {
  vendor: "codex" | "minimax";
  model: string;
  description?: string;
}

interface ModelStore {
  schemaVersion: "1.0";
  updatedAt: string;
  models: ModelInfo[];
}

export interface ModelListResponse {
  models: ModelInfo[];
  warnings: string[];
  source: "cache" | "refresh" | "fallback-mixed";
}

const DEFAULT_MODELS: Record<ModelInfo["vendor"], ModelInfo[]> = {
  codex: DEFAULT_CODEX_MODELS.map((model) => ({
    vendor: "codex" as const,
    model,
    description: `Codex model: ${model}`
  })),
  minimax: []
};

function resolveDataRootFromProjectRoot(projectRootDir: string): string {
  return path.resolve(projectRootDir, "..", "..");
}

function parseModelOutput(vendor: ModelInfo["vendor"], output: string): ModelInfo[] {
  const lines = output
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const model of lines) {
    const key = `${vendor}:${model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    models.push({
      vendor,
      model,
      description: `${vendor} model: ${model}`
    });
  }
  return models;
}

function parseCommand(command: string): { bin: string; args: string[] } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { bin: "", args: [] };
  }
  const parts = trimmed.split(/\s+/g);
  return {
    bin: parts[0],
    args: parts.slice(1)
  };
}

export class ModelManagerService {
  private readonly paths: ProjectPaths;
  private readonly dataRoot: string;
  private readonly commandTimeoutMs: number;

  constructor(paths: ProjectPaths, dataRoot?: string, commandTimeoutMs = 8000) {
    this.paths = paths;
    this.dataRoot = dataRoot ?? resolveDataRootFromProjectRoot(paths.projectRootDir);
    this.commandTimeoutMs = commandTimeoutMs;
  }

  async getAvailableModels(): Promise<ModelListResponse> {
    const runtimeSettings = await this.loadRuntimeSettings();
    const store = await this.loadModelStore();
    if (store.models.length === 0) {
      return this.refreshModels();
    }
    const normalized = this.normalizeModelsWithRuntime(store.models, runtimeSettings);
    if (JSON.stringify(normalized) !== JSON.stringify(store.models)) {
      const next: ModelStore = {
        ...store,
        updatedAt: new Date().toISOString(),
        models: normalized
      };
      await this.saveModelStore(next);
    }
    return {
      models: normalized,
      warnings: [],
      source: "cache"
    };
  }

  async refreshModels(): Promise<ModelListResponse> {
    const runtimeSettings = await this.loadRuntimeSettings();
    const warnings: string[] = [];
    const codex = await this.getVendorModels("codex", runtimeSettings.codexCliCommand, warnings);
    const minimax = this.resolveMiniMaxModels(runtimeSettings);
    const models = [...codex, ...minimax];
    const store: ModelStore = {
      schemaVersion: "1.0",
      updatedAt: new Date().toISOString(),
      models
    };
    await this.saveModelStore(store);
    return {
      models,
      warnings,
      source: warnings.length > 0 ? "fallback-mixed" : "refresh"
    };
  }

  private async getVendorModels(
    vendor: ModelInfo["vendor"],
    command: string,
    warnings: string[]
  ): Promise<ModelInfo[]> {
    const configured = command.trim().length > 0 ? command.trim() : vendor;
    const output = await this.runModelListCommand(configured);
    if (!output.ok) {
      warnings.push(`${vendor}: ${output.warning}`);
      return DEFAULT_MODELS[vendor];
    }
    const parsed = parseModelOutput(vendor, output.stdout);
    if (parsed.length === 0) {
      warnings.push(`${vendor}: empty model list, fallback to defaults`);
      return DEFAULT_MODELS[vendor];
    }
    return parsed;
  }

  private resolveMiniMaxModels(runtimeSettings: RuntimeSettings): ModelInfo[] {
    const configured = runtimeSettings.minimaxModel?.trim();
    const model = configured && configured.length > 0 ? configured : DEFAULT_MINIMAX_MODEL;
    return [{ vendor: "minimax", model, description: `MiniMax model: ${model}` }];
  }

  private normalizeModelsWithRuntime(models: ModelInfo[], runtimeSettings: RuntimeSettings): ModelInfo[] {
    const deduped = new Map<string, ModelInfo>();
    for (const model of models) {
      const key = `${model.vendor}:${model.model}`;
      if (!deduped.has(key)) {
        deduped.set(key, model);
      }
    }
    for (const minimaxModel of this.resolveMiniMaxModels(runtimeSettings)) {
      const key = `${minimaxModel.vendor}:${minimaxModel.model}`;
      if (!deduped.has(key)) {
        deduped.set(key, minimaxModel);
      }
    }
    return [...deduped.values()];
  }

  private async runModelListCommand(
    command: string
  ): Promise<{ ok: true; stdout: string } | { ok: false; warning: string }> {
    const parsed = parseCommand(command);
    if (!parsed.bin) {
      return { ok: false, warning: "empty command" };
    }
    return await new Promise((resolve) => {
      const child = spawn(parsed.bin, [...parsed.args, "-m"], {
        cwd: this.paths.projectRootDir,
        shell: false
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill();
        resolve({ ok: false, warning: `command timeout after ${this.commandTimeoutMs}ms` });
      }, this.commandTimeoutMs);

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString("utf8");
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf8");
      });
      child.on("error", (err: Error) => {
        clearTimeout(timeout);
        resolve({ ok: false, warning: `spawn error: ${err.message}` });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timeout);
        if (code !== 0) {
          const sampled = stderr.trim().slice(0, 240);
          resolve({ ok: false, warning: `exit=${String(code)} stderr=${sampled}` });
          return;
        }
        resolve({ ok: true, stdout });
      });
    });
  }

  private async loadRuntimeSettings(): Promise<RuntimeSettings> {
    try {
      return await getRuntimeSettings(this.dataRoot);
    } catch {
      return {
        schemaVersion: "1.0",
        updatedAt: new Date().toISOString(),
        codexCliCommand: "codex",
        minimaxModel: DEFAULT_MINIMAX_MODEL
      };
    }
  }

  private async loadModelStore(): Promise<ModelStore> {
    const modelStoreFile = this.getModelStoreFile();
    const fallback: ModelStore = {
      schemaVersion: "1.0",
      updatedAt: new Date().toISOString(),
      models: []
    };
    return readJsonFile<ModelStore>(modelStoreFile, fallback);
  }

  private async saveModelStore(store: ModelStore): Promise<void> {
    await writeJsonFile(this.getModelStoreFile(), store);
  }

  private getModelStoreFile(): string {
    return path.join(this.paths.projectRootDir, "models.json");
  }
}

export function createModelManagerService(paths: ProjectPaths, dataRoot?: string): ModelManagerService {
  return new ModelManagerService(paths, dataRoot);
}
