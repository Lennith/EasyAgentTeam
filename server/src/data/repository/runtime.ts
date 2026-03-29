import path from "node:path";
import { deleteDirectoryTransactional, deleteFileTransactional, ensureDirectory, ensureFile, runStorageTransaction } from "../file-utils.js";
import { FileDocumentStore, FileLogStore } from "../store/file-store.js";
import { MemoryDocumentStore, MemoryLogStore } from "../store/memory-store.js";
import type { DocumentStore, LogStore } from "../store/store-interface.js";
import { getDocumentStore, getLogStore, getStorageBackend, listDocumentFiles, type StorageBackend } from "../store/store-runtime.js";
import type { Repository, UnitOfWork } from "./types.js";

type BackendMode = StorageBackend | "auto";

class DefaultRepository implements Repository {
  private readonly fixedDocumentStore?: DocumentStore<unknown>;
  private readonly fixedLogStore?: LogStore<unknown>;

  constructor(private readonly backend: BackendMode = "auto") {
    if (backend === "file") {
      this.fixedDocumentStore = new FileDocumentStore<unknown>();
      this.fixedLogStore = new FileLogStore<unknown>();
      return;
    }
    if (backend === "memory") {
      this.fixedDocumentStore = new MemoryDocumentStore<unknown>();
      this.fixedLogStore = new MemoryLogStore<unknown>();
    }
  }

  private resolveBackend(): StorageBackend {
    return this.backend === "auto" ? getStorageBackend() : this.backend;
  }

  private documentStore<T>(): DocumentStore<T> {
    if (this.fixedDocumentStore) {
      return this.fixedDocumentStore as DocumentStore<T>;
    }
    return getDocumentStore<T>();
  }

  private logStore<T>(): LogStore<T> {
    if (this.fixedLogStore) {
      return this.fixedLogStore as LogStore<T>;
    }
    return getLogStore<T>();
  }

  private async hasDocument(targetFile: string): Promise<boolean> {
    const resolved = path.resolve(targetFile);
    const files = await this.listFiles(path.dirname(resolved));
    return files.includes(resolved);
  }

  async ensureDirectory(targetDir: string): Promise<void> {
    if (this.resolveBackend() === "memory") {
      return;
    }
    await ensureDirectory(targetDir);
  }

  async ensureFile(targetFile: string, initialContent: string): Promise<void> {
    if (this.resolveBackend() === "file") {
      await ensureFile(targetFile, initialContent);
      return;
    }
    if (await this.hasDocument(targetFile)) {
      return;
    }
    const trimmed = initialContent.trim();
    if (trimmed.length === 0) {
      return;
    }
    try {
      await this.writeJson(targetFile, JSON.parse(trimmed));
    } catch {
      // memory backend keeps non-JSON bootstrap files implicit.
    }
  }

  async readJson<T>(targetFile: string, fallback: T): Promise<T> {
    return this.documentStore<T>().read(targetFile, fallback);
  }

  async writeJson<T>(targetFile: string, payload: T): Promise<void> {
    await this.documentStore<T>().write(targetFile, payload);
  }

  async appendJsonl<T>(targetFile: string, payload: T): Promise<void> {
    await this.logStore<T>().append(targetFile, payload);
  }

  async readJsonl<T>(targetFile: string): Promise<T[]> {
    return this.logStore<T>().list(targetFile);
  }

  async writeJsonl<T>(targetFile: string, payload: T[]): Promise<void> {
    await this.logStore<T>().overwrite(targetFile, payload);
  }

  async listFiles(directoryPath: string): Promise<string[]> {
    const store = this.documentStore<unknown>() as DocumentStore<unknown> & { list?: (path: string) => Promise<string[]> };
    if (typeof store.list === "function") {
      const files = await store.list(directoryPath);
      return files.map((item) => path.resolve(item)).sort((a, b) => a.localeCompare(b));
    }
    return listDocumentFiles(directoryPath);
  }

  async deleteFile(targetFile: string): Promise<void> {
    if (this.resolveBackend() === "file") {
      await deleteFileTransactional(targetFile);
      return;
    }
    const store = this.documentStore<unknown>() as DocumentStore<unknown> & { delete?: (path: string) => Promise<void> };
    if (typeof store.delete === "function") {
      await store.delete(targetFile);
      return;
    }
  }

  async deleteDirectory(targetDir: string): Promise<void> {
    if (this.resolveBackend() === "memory") {
      return;
    }
    await deleteDirectoryTransactional(targetDir);
  }
}

class DefaultUnitOfWork implements UnitOfWork {
  constructor(private readonly backend: BackendMode = "auto") {}

  private resolveBackend(): StorageBackend {
    return this.backend === "auto" ? getStorageBackend() : this.backend;
  }

  run<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
    if (this.resolveBackend() === "memory") {
      return operation();
    }
    return runStorageTransaction(paths, operation);
  }
}

const repository: Repository = new DefaultRepository("auto");
const unitOfWork: UnitOfWork = new DefaultUnitOfWork("auto");

export function createRepository(backend: StorageBackend): Repository {
  return new DefaultRepository(backend);
}

export function createUnitOfWork(backend: StorageBackend): UnitOfWork {
  return new DefaultUnitOfWork(backend);
}

export function getRepository(): Repository {
  return repository;
}

export function getUnitOfWork(): UnitOfWork {
  return unitOfWork;
}
