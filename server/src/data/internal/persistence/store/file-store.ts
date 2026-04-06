import fs from "node:fs/promises";
import path from "node:path";
import { appendJsonlLine, readJsonFile, readJsonlLines, writeJsonFile, writeJsonlLines } from "../file-utils.js";
import type { DocumentStore, LogStore } from "./store-interface.js";

export class FileDocumentStore<T> implements DocumentStore<T> {
  async read(filePath: string, fallback: T): Promise<T> {
    return readJsonFile<T>(filePath, fallback);
  }

  async write(filePath: string, value: T): Promise<void> {
    await writeJsonFile(filePath, value);
  }

  async list(directoryPath: string): Promise<string[]> {
    const normalized = path.resolve(directoryPath);
    try {
      const entries = await fs.readdir(normalized, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(normalized, entry.name))
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      const known = error as NodeJS.ErrnoException;
      if (known.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async delete(filePath: string): Promise<void> {
    await fs.rm(filePath, { force: true });
  }
}

export class FileLogStore<T> implements LogStore<T> {
  async append(filePath: string, value: T): Promise<void> {
    await appendJsonlLine(filePath, value);
  }

  async list(filePath: string): Promise<T[]> {
    return readJsonlLines<T>(filePath);
  }

  async overwrite(filePath: string, values: T[]): Promise<void> {
    await writeJsonlLines<T>(filePath, values);
  }
}
