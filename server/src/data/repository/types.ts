export interface Repository {
  ensureDirectory(targetDir: string): Promise<void>;
  ensureFile(targetFile: string, initialContent: string): Promise<void>;
  readJson<T>(targetFile: string, fallback: T): Promise<T>;
  writeJson<T>(targetFile: string, payload: T): Promise<void>;
  appendJsonl<T>(targetFile: string, payload: T): Promise<void>;
  readJsonl<T>(targetFile: string): Promise<T[]>;
  writeJsonl<T>(targetFile: string, payload: T[]): Promise<void>;
  listFiles(directoryPath: string): Promise<string[]>;
  deleteFile(targetFile: string): Promise<void>;
  deleteDirectory(targetDir: string): Promise<void>;
}

export interface UnitOfWork {
  run<T>(paths: string[], operation: () => Promise<T>): Promise<T>;
}
