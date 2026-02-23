import { spawn } from "node:child_process";
import path from "node:path";
import type { ProjectPaths } from "../domain/models.js";
import { readJsonFile, writeJsonFile } from "../data/file-utils.js";
import { getRuntimeSettings, type RuntimeSettings } from "../data/runtime-settings-store.js";

export interface ModelInfo {
  vendor: "codex" | "trae" | "minimax";
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
  codex: [
    { vendor: "codex", model: "gpt-5.3-codex", description: "Codex recommended model" },
    { vendor: "codex", model: "gpt-5", description: "GPT-5 model" }
  ],
  trae: [{ vendor: "trae", model: "trae-1", description: "Trae 1 model" }],
  minimax: [
    { vendor: "minimax", model: "MiniMax-M2.5", description: "MiniMax M2.5 model" },
    { vendor: "minimax", model: "MiniMax-M2", description: "MiniMax M2 model" },
    { vendor: "minimax", model: "abab6.5-chat", description: "MiniMax abab6.5 chat model" },
    { vendor: "minimax", model: "abab6.5s-chat", description: "MiniMax abab6.5s chat model" },
    { vendor: "minimax", model: "abab6-chat", description: "MiniMax abab6 chat model" }
  ]
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
    const store = await this.loadModelStore();
    if (store.models.length === 0) {
      return this.refreshModels();
    }
    return {
      models: store.models,
      warnings: [],
      source: "cache"
    };
  }

  async refreshModels(): Promise<ModelListResponse> {
    const runtimeSettings = await this.loadRuntimeSettings();
    const warnings: string[] = [];
    const codex = await this.getVendorModels("codex", runtimeSettings.codexCliCommand, warnings);
    const trae = await this.getVendorModels("trae", runtimeSettings.traeCliCommand, warnings);
    const minimax = DEFAULT_MODELS.minimax;
    const models = [...codex, ...trae, ...minimax];
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

  private async runModelListCommand(command: string): Promise<{ ok: true; stdout: string } | { ok: false; warning: string }> {
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
        traeCliCommand: "trae"
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
