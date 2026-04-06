import fs from "node:fs/promises";
import path from "node:path";

const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(targetFile: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(targetFile) ?? Promise.resolve();
  let release = () => {};
  const current: Promise<void> = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  fileLocks.set(
    targetFile,
    previous.then(() => current)
  );

  await previous;
  try {
    return await operation();
  } finally {
    release?.();
    if (fileLocks.get(targetFile) === current) {
      fileLocks.delete(targetFile);
    }
  }
}

export async function ensureDirectory(targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
}

export async function readJsonFile<T>(targetFile: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(targetFile, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

export async function writeJsonFile(targetFile: string, payload: unknown): Promise<void> {
  await ensureDirectory(path.dirname(targetFile));
  await withFileLock(targetFile, async () => {
    await fs.writeFile(targetFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  });
}

export async function appendJsonlLine(targetFile: string, payload: unknown): Promise<void> {
  await ensureDirectory(path.dirname(targetFile));
  await withFileLock(targetFile, async () => {
    await fs.appendFile(targetFile, `${JSON.stringify(payload)}\n`, "utf8");
  });
}
