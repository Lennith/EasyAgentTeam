import fs from "node:fs/promises";
import path from "node:path";

const JSON_READ_RETRY_ATTEMPTS = 3;
const JSON_READ_RETRY_BASE_DELAY_MS = 15;

class FileAccessMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

const fileAccessMutexes = new Map<string, FileAccessMutex>();

function getFileAccessMutex(targetFile: string): FileAccessMutex {
  const existing = fileAccessMutexes.get(targetFile);
  if (existing) {
    return existing;
  }
  const created = new FileAccessMutex();
  fileAccessMutexes.set(targetFile, created);
  return created;
}

function withFileAccessLock<T>(targetFile: string, operation: () => Promise<T>): Promise<T> {
  return getFileAccessMutex(targetFile).runExclusive(operation);
}

function isUnexpectedEndJsonError(error: unknown): boolean {
  if (!(error instanceof SyntaxError)) {
    return false;
  }
  const message = error.message || "";
  return message.includes("Unexpected end of JSON input");
}

function isJsonSyntaxError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureDirectory(targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
}

export async function ensureFile(targetFile: string, initialContent: string): Promise<void> {
  await withFileAccessLock(targetFile, async () => {
    try {
      await fs.access(targetFile);
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code !== "ENOENT") {
        throw error;
      }
      await ensureDirectory(path.dirname(targetFile));
      await fs.writeFile(targetFile, initialContent, "utf8");
    }
  });
}

export async function readJsonFile<T>(targetFile: string, fallback: T): Promise<T> {
  for (let attempt = 0; attempt < JSON_READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const raw = await withFileAccessLock(targetFile, () => fs.readFile(targetFile, "utf8"));
      return JSON.parse(raw) as T;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        return fallback;
      }
      if (isUnexpectedEndJsonError(error) && attempt < JSON_READ_RETRY_ATTEMPTS - 1) {
        await delay(JSON_READ_RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  return fallback;
}

export async function writeJsonFile(targetFile: string, payload: unknown): Promise<void> {
  await withFileAccessLock(targetFile, async () => {
    await ensureDirectory(path.dirname(targetFile));
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    await fs.writeFile(targetFile, serialized, "utf8");
  });
}

export async function appendJsonlLine(targetFile: string, payload: unknown): Promise<void> {
  await withFileAccessLock(targetFile, async () => {
    const dir = path.dirname(targetFile);
    await ensureDirectory(dir);
    await fs.appendFile(targetFile, `${JSON.stringify(payload)}\n`, "utf8");
  });
}

export async function readJsonlLines<T>(targetFile: string): Promise<T[]> {
  for (let attempt = 0; attempt < JSON_READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const raw = await withFileAccessLock(targetFile, () => fs.readFile(targetFile, "utf8"));
      const rawLines = raw.split("\n");
      const parsed: T[] = [];
      let parseError: unknown = null;
      let recoverablePartialTail = false;

      for (let i = 0; i < rawLines.length; i += 1) {
        const line = rawLines[i]?.trim() ?? "";
        if (line.length === 0) {
          continue;
        }
        try {
          parsed.push(JSON.parse(line) as T);
        } catch (error) {
          const isLastLine =
            i === rawLines.length - 1 || (i === rawLines.length - 2 && rawLines[rawLines.length - 1] === "");
          recoverablePartialTail = isLastLine && !raw.endsWith("\n") && isJsonSyntaxError(error);
          parseError = error;
          break;
        }
      }

      if (!parseError) {
        return parsed;
      }

      if (isJsonSyntaxError(parseError) && attempt < JSON_READ_RETRY_ATTEMPTS - 1) {
        await delay(JSON_READ_RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      if (recoverablePartialTail) {
        return parsed;
      }
      throw parseError;
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        return [];
      }
      if (isJsonSyntaxError(error) && attempt < JSON_READ_RETRY_ATTEMPTS - 1) {
        await delay(JSON_READ_RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  return [];
}

export async function writeJsonlLines<T>(targetFile: string, lines: T[]): Promise<void> {
  await withFileAccessLock(targetFile, async () => {
    await ensureDirectory(path.dirname(targetFile));
    const content = lines.map((line) => JSON.stringify(line)).join("\n");
    const finalContent = content.length > 0 ? `${content}\n` : "";
    await fs.writeFile(targetFile, finalContent, "utf8");
  });
}
