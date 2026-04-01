import fs from "node:fs/promises";
import path from "node:path";
import { FileDocumentStore, FileLogStore } from "./file-store.js";
import { MemoryDocumentStore, MemoryLogStore } from "./memory-store.js";
import type { DocumentStore, LogStore } from "./store-interface.js";

export type StorageBackend = "file" | "memory";

function normalizeBackend(raw: string | undefined): StorageBackend {
  const normalized = String(raw ?? "file")
    .trim()
    .toLowerCase();
  return normalized === "memory" ? "memory" : "file";
}

let backendOverride: StorageBackend | null = null;

function resolveBackend(): StorageBackend {
  if (backendOverride) {
    return backendOverride;
  }
  return normalizeBackend(process.env.AUTO_DEV_STORAGE_BACKEND);
}

const fileDocumentStore = new FileDocumentStore<unknown>();
const fileLogStore = new FileLogStore<unknown>();
const memoryDocumentStore = new MemoryDocumentStore<unknown>();
const memoryLogStore = new MemoryLogStore<unknown>();

function resolveDocumentStore<T>(): DocumentStore<T> {
  if (resolveBackend() === "memory") {
    return memoryDocumentStore as DocumentStore<T>;
  }
  return fileDocumentStore as DocumentStore<T>;
}

function resolveLogStore<T>(): LogStore<T> {
  if (resolveBackend() === "memory") {
    return memoryLogStore as LogStore<T>;
  }
  return fileLogStore as LogStore<T>;
}

export function getStorageBackend(): StorageBackend {
  return resolveBackend();
}

export function setStorageBackendForTests(backend: StorageBackend | null): void {
  backendOverride = backend;
}

export function getDocumentStore<T>(): DocumentStore<T> {
  return resolveDocumentStore<T>();
}

export function getLogStore<T>(): LogStore<T> {
  return resolveLogStore<T>();
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  return resolveDocumentStore<T>().read(filePath, fallback);
}

export async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  await resolveDocumentStore<T>().write(filePath, value);
}

export async function appendJsonlLine<T>(filePath: string, value: T): Promise<void> {
  await resolveLogStore<T>().append(filePath, value);
}

export async function readJsonlLines<T>(filePath: string): Promise<T[]> {
  return resolveLogStore<T>().list(filePath);
}

export async function writeJsonlLines<T>(filePath: string, values: T[]): Promise<void> {
  await resolveLogStore<T>().overwrite(filePath, values);
}

interface DocumentStoreWithExtraOps<T> extends DocumentStore<T> {
  list?(directoryPath: string): Promise<string[]>;
  delete?(filePath: string): Promise<void>;
}

export async function listDocumentFiles(directoryPath: string): Promise<string[]> {
  const store = resolveDocumentStore<unknown>() as DocumentStoreWithExtraOps<unknown>;
  const resolved = path.resolve(directoryPath);
  if (typeof store.list === "function") {
    return store.list(resolved);
  }
  return [];
}

export async function deleteDocument(filePath: string): Promise<void> {
  const resolved = path.resolve(filePath);
  const store = resolveDocumentStore<unknown>() as DocumentStoreWithExtraOps<unknown>;
  if (typeof store.delete === "function") {
    await store.delete(resolved);
    return;
  }
  await fs.rm(resolved, { force: true });
}

export function clearMemoryStore(): void {
  memoryDocumentStore.clear();
  memoryLogStore.clear();
}
