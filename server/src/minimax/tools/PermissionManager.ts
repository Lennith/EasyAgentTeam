import * as path from 'path';
import type { PermissionCheckResult, DirectoryPermissions } from '../types.js';

export class PermissionManager {
  private workspaceDir: string;
  private writableDirs: Set<string>;
  private readableDirs: Set<string>;

  constructor(options: DirectoryPermissions) {
    this.workspaceDir = path.resolve(options.workspaceDir);
    this.writableDirs = new Set([this.workspaceDir]);
    this.readableDirs = new Set([this.workspaceDir]);

    for (const dir of options.additionalWritableDirs) {
      const resolved = path.resolve(dir);
      this.writableDirs.add(resolved);
      this.readableDirs.add(resolved);
    }
  }

  checkPermission(filePath: string, operation: 'read' | 'write'): PermissionCheckResult {
    const resolved = path.resolve(filePath);
    
    if (operation === 'read') {
      return this.checkRead(resolved);
    }
    
    return this.checkWrite(resolved);
  }

  private checkRead(filePath: string): PermissionCheckResult {
    for (const dir of this.readableDirs) {
      if (filePath.startsWith(dir + path.sep) || filePath === dir) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `Path "${filePath}" is outside readable directories`,
    };
  }

  private checkWrite(filePath: string): PermissionCheckResult {
    for (const dir of this.writableDirs) {
      if (filePath.startsWith(dir + path.sep) || filePath === dir) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `Path "${filePath}" is outside writable directories`,
    };
  }

  addWritableDir(dir: string): void {
    const resolved = path.resolve(dir);
    this.writableDirs.add(resolved);
    this.readableDirs.add(resolved);
  }

  addReadableDir(dir: string): void {
    const resolved = path.resolve(dir);
    this.readableDirs.add(resolved);
  }

  removeWritableDir(dir: string): void {
    const resolved = path.resolve(dir);
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
    return this.checkPermission(filePath, 'write').allowed;
  }

  isReadable(filePath: string): boolean {
    return this.checkPermission(filePath, 'read').allowed;
  }

  createPermissionChecker(): (filePath: string, operation: 'read' | 'write') => PermissionCheckResult {
    return (filePath: string, operation: 'read' | 'write') => this.checkPermission(filePath, operation);
  }
}

export function createPermissionManager(options: DirectoryPermissions): PermissionManager {
  return new PermissionManager(options);
}
