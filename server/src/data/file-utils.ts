import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDirectory(targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
}

export async function ensureFile(targetFile: string, initialContent: string): Promise<void> {
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
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  await fs.writeFile(targetFile, serialized, "utf8");
}

export async function appendJsonlLine(targetFile: string, payload: unknown): Promise<void> {
  const dir = path.dirname(targetFile);
  await ensureDirectory(dir);
  await fs.appendFile(targetFile, `${JSON.stringify(payload)}\n`, "utf8");
}

export async function readJsonlLines<T>(targetFile: string): Promise<T[]> {
  try {
    const raw = await fs.readFile(targetFile, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as T);
  } catch (error) {
    const known = error as NodeJS.ErrnoException;
    if (known.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function writeJsonlLines<T>(targetFile: string, lines: T[]): Promise<void> {
  await ensureDirectory(path.dirname(targetFile));
  const content = lines.map((line) => JSON.stringify(line)).join("\n");
  const finalContent = content.length > 0 ? `${content}\n` : "";
  await fs.writeFile(targetFile, finalContent, "utf8");
}

