import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { Server } from "node:http";
import { createApp, resolveDataRoot, stopAppRuntime } from "./app.js";
import {
  cleanupCommittedWalRecordsForPaths,
  ensureStorageRecoveryForPaths
} from "./data/internal/persistence/storage/transaction-manager.js";
import { logger } from "./utils/logger.js";

const port = Number(process.env.PORT ?? 43123);
const host = process.env.HOST ?? "127.0.0.1";
const dataRoot = resolveDataRoot();
let appInstance: ReturnType<typeof createApp> | null = null;
let httpServer: Server | null = null;
let fatalShutdownStarted = false;

async function discoverWalRoots(basePath: string): Promise<string[]> {
  const normalizedRoot = path.resolve(basePath);
  const discovered = new Set<string>([path.join(normalizedRoot, ".storage-wal")]);
  const stack = [normalizedRoot];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    let entries: Dirent[] = [];
    try {
      const readEntries = await fs.readdir(dir, { withFileTypes: true });
      entries = readEntries as Dirent[];
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT" || known.code === "ENOTDIR") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const child = path.join(dir, entry.name);
      if (entry.name === ".storage-wal") {
        discovered.add(child);
        continue;
      }
      stack.push(child);
    }
  }

  return Array.from(discovered).sort((a, b) => a.localeCompare(b));
}

async function recoverAndCleanupWalRoots(basePath: string): Promise<void> {
  const walRoots = await discoverWalRoots(basePath);
  await Promise.all(
    walRoots.map(async (walRoot) => {
      await ensureStorageRecoveryForPaths([walRoot]);
      await cleanupCommittedWalRecordsForPaths([walRoot]);
    })
  );
}

async function shutdownAfterFatal(reason: string, error: unknown): Promise<void> {
  logger.error(`[server] ${reason}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
  if (fatalShutdownStarted) {
    return;
  }
  fatalShutdownStarted = true;
  if (appInstance) {
    await stopAppRuntime(appInstance, httpServer ?? undefined).catch((shutdownError) => {
      logger.error(`[server] fatal shutdown cleanup failed: ${shutdownError}`);
    });
  }
}

process.on("uncaughtException", (error) => {
  logger.error(`[server] Uncaught Exception: ${error}`);
  void shutdownAfterFatal("Uncaught Exception", error);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error(`[server] Unhandled Rejection at: ${promise}, reason: ${reason}`);
  void shutdownAfterFatal("Unhandled Rejection", reason);
});

async function main(): Promise<void> {
  await recoverAndCleanupWalRoots(dataRoot);

  const app = createApp({ dataRoot });
  appInstance = app;
  httpServer = app.listen(port, host, () => {
    logger.info(`[server] listening on http://${host}:${port}`);
    logger.info(`[server] data root: ${dataRoot}`);
  });
}

void main().catch((error) => {
  logger.error(`[server] bootstrap failed: ${error}`);
  process.exitCode = 1;
});
