export type StorageOperationType =
  | "putJson"
  | "overwriteJsonl"
  | "appendJsonl"
  | "mkdir"
  | "renameDir"
  | "deleteDir"
  | "deleteFile";

export interface StorageTransaction {
  putJson(filePath: string, serializedContent: string): Promise<void>;
  overwriteJsonl(filePath: string, content: string): Promise<void>;
  appendJsonl(filePath: string, line: string): Promise<void>;
  mkdir(dirPath: string): Promise<void>;
  renameDir(sourcePath: string, targetPath: string): Promise<void>;
  deleteDir(dirPath: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface DocumentStore<T> {
  read(filePath: string, fallback: T): Promise<T>;
  write(filePath: string, value: T): Promise<void>;
  list?(directoryPath: string): Promise<string[]>;
  delete?(filePath: string): Promise<void>;
}

export interface LogStore<T> {
  append(filePath: string, value: T): Promise<void>;
  list(filePath: string): Promise<T[]>;
  overwrite(filePath: string, values: T[]): Promise<void>;
}
