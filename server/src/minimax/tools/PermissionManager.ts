import * as path from "path";
import * as fs from "fs";
import type { PermissionCheckResult, DirectoryPermissions } from "../types.js";

function normalizeForCompare(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resolveExistingRealPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function resolveRealPathForPermission(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    let existingParent = path.dirname(resolved);
    const missingSegments = [path.basename(resolved)];
    while (existingParent && existingParent !== path.dirname(existingParent)) {
      try {
        const realParent = fs.realpathSync.native(existingParent);
        return path.join(realParent, ...missingSegments.reverse());
      } catch {
        missingSegments.push(path.basename(existingParent));
        existingParent = path.dirname(existingParent);
      }
    }
    return resolved;
  }
}

function isPathInsideDirectory(targetPath: string, dir: string): boolean {
  const target = normalizeForCompare(targetPath);
  const root = normalizeForCompare(dir);
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class PermissionManager {
  private workspaceDir: string;
  private writableDirs: Set<string>;
  private readableDirs: Set<string>;

  constructor(options: DirectoryPermissions) {
    this.workspaceDir = resolveExistingRealPath(options.workspaceDir);
    this.writableDirs = new Set([this.workspaceDir]);
    this.readableDirs = new Set([this.workspaceDir]);

    for (const dir of options.additionalWritableDirs) {
      const resolved = resolveExistingRealPath(dir);
      this.writableDirs.add(resolved);
      this.readableDirs.add(resolved);
    }
  }

  checkPermission(filePath: string, operation: "read" | "write"): PermissionCheckResult {
    const resolved = resolveRealPathForPermission(filePath);

    if (operation === "read") {
      return this.checkRead(resolved);
    }

    return this.checkWrite(resolved);
  }

  private checkRead(filePath: string): PermissionCheckResult {
    for (const dir of this.readableDirs) {
      if (isPathInsideDirectory(filePath, dir)) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `Path "${filePath}" is outside readable directories`
    };
  }

  private checkWrite(filePath: string): PermissionCheckResult {
    for (const dir of this.writableDirs) {
      if (isPathInsideDirectory(filePath, dir)) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `Path "${filePath}" is outside writable directories`
    };
  }

  addWritableDir(dir: string): void {
    const resolved = resolveExistingRealPath(dir);
    this.writableDirs.add(resolved);
    this.readableDirs.add(resolved);
  }

  addReadableDir(dir: string): void {
    const resolved = resolveExistingRealPath(dir);
    this.readableDirs.add(resolved);
  }

  removeWritableDir(dir: string): void {
    const resolved = resolveExistingRealPath(dir);
    this.writableDirs.delete(resolved);
  }

  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  getWritableDirs(): string[] {
    return Array.from(this.writableDirs);
  }

  getReadableDirs(): string[] {
    return Array.from(this.readableDirs);
  }

  isWritable(filePath: string): boolean {
    return this.checkPermission(filePath, "write").allowed;
  }

  isReadable(filePath: string): boolean {
    return this.checkPermission(filePath, "read").allowed;
  }

  createPermissionChecker(): (filePath: string, operation: "read" | "write") => PermissionCheckResult {
    return (filePath: string, operation: "read" | "write") => this.checkPermission(filePath, operation);
  }
}

export function createPermissionManager(options: DirectoryPermissions): PermissionManager {
  return new PermissionManager(options);
}
