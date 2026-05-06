import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

export interface TriggerPluginValidationResult {
  doCheck: boolean;
  onCheckResult: boolean;
  hasCompletionHook: boolean;
}

interface WorkerSuccess<T> {
  ok: true;
  result: T;
}

interface WorkerFailure {
  ok: false;
  error: string;
  stack?: string;
  result?: unknown;
}

type WorkerMessage<T> = WorkerSuccess<T> | WorkerFailure;

const moduleRequire = createRequire(import.meta.url);

function resolveTsxImportArg(): string | null {
  try {
    return pathToFileURL(moduleRequire.resolve("tsx")).href;
  } catch {
    return null;
  }
}

function resolveWorkerUrl(): URL {
  const currentPath = fileURLToPath(import.meta.url);
  const workerName = currentPath.endsWith(".ts") ? "trigger-plugin-worker.ts" : "trigger-plugin-worker.js";
  return new URL(`./${workerName}`, import.meta.url);
}

function shouldUseTsx(entryPath: string): boolean {
  const ext = path.extname(entryPath).toLowerCase();
  return ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts";
}

export class TriggerPluginRunner {
  async validate(entryPath: string, timeoutMs = 5000): Promise<TriggerPluginValidationResult> {
    return this.runHook<TriggerPluginValidationResult>(entryPath, "__validate", [], timeoutMs);
  }

  async runHook<T>(entryPath: string, hook: string, args: unknown[], timeoutMs: number): Promise<T> {
    const execArgv: string[] = [];
    const workerNeedsTsx = fileURLToPath(import.meta.url).endsWith(".ts");
    const tsxArg = shouldUseTsx(entryPath) || workerNeedsTsx ? resolveTsxImportArg() : null;
    if (tsxArg) {
      execArgv.push("--import", tsxArg);
    }
    return new Promise<T>((resolve, reject) => {
      const worker = new Worker(resolveWorkerUrl(), {
        workerData: { entryPath, hook, args },
        execArgv
      });
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        worker.terminate().catch(() => {});
        reject(new Error(`trigger plugin hook '${hook}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      worker.once("message", (message: WorkerMessage<T>) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        worker.terminate().catch(() => {});
        if (message.ok) {
          resolve(message.result);
          return;
        }
        reject(new Error(message.error));
      });
      worker.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      worker.once("exit", (code) => {
        if (settled || code === 0) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`trigger plugin worker exited with code ${code}`));
      });
      timeout.unref?.();
    });
  }
}
