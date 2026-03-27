import path from "node:path";
import type { DocumentStore, LogStore } from "./store-interface.js";

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class MemoryDocumentStore<T> implements DocumentStore<T> {
  private readonly data = new Map<string, T>();

  async read(filePath: string, fallback: T): Promise<T> {
    const resolvedPath = path.resolve(filePath);
    const value = this.data.get(resolvedPath);
    if (value === undefined) {
      return deepClone(fallback);
    }
    return deepClone(value);
  }

  async write(filePath: string, value: T): Promise<void> {
    const resolvedPath = path.resolve(filePath);
    this.data.set(resolvedPath, deepClone(value));
  }

  async list(directoryPath: string): Promise<string[]> {
    const normalizedDir = path.resolve(directoryPath);
    const normalizedPrefix = normalizedDir.endsWith(path.sep) ? normalizedDir : `${normalizedDir}${path.sep}`;
    const results: string[] = [];
    for (const key of this.data.keys()) {
      const normalizedKey = path.resolve(key);
      if (!normalizedKey.startsWith(normalizedPrefix)) {
        continue;
      }
      const relative = normalizedKey.slice(normalizedPrefix.length);
      if (!relative || relative.includes(path.sep)) {
        continue;
      }
      results.push(normalizedKey);
    }
    return results.sort((a, b) => a.localeCompare(b));
  }

  async delete(filePath: string): Promise<void> {
    const resolvedPath = path.resolve(filePath);
    this.data.delete(resolvedPath);
  }

  clear(): void {
    this.data.clear();
  }
}

export class MemoryLogStore<T> implements LogStore<T> {
  private readonly data = new Map<string, T[]>();

  async append(filePath: string, value: T): Promise<void> {
    const existing = this.data.get(filePath) ?? [];
    existing.push(deepClone(value));
    this.data.set(filePath, existing);
  }

  async list(filePath: string): Promise<T[]> {
    return deepClone(this.data.get(filePath) ?? []);
  }

  async overwrite(filePath: string, values: T[]): Promise<void> {
    this.data.set(filePath, deepClone(values));
  }

  clear(): void {
    this.data.clear();
  }
}
