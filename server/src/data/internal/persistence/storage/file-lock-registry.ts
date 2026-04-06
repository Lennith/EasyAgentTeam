import path from "node:path";

type ReleaseLock = () => void;

interface LockTail {
  token: symbol;
  promise: Promise<void>;
}

class FileLockRegistry {
  private readonly tails = new Map<string, LockTail>();

  async acquire(filePath: string): Promise<ReleaseLock> {
    const normalized = normalizePath(filePath);
    const token = Symbol(normalized);
    const previous = this.tails.get(normalized)?.promise ?? Promise.resolve();
    let resolveCurrent: (() => void) | null = null;
    const current = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    this.tails.set(normalized, {
      token,
      promise: previous.then(
        () => current,
        () => current
      )
    });

    await previous;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      resolveCurrent?.();
      const tail = this.tails.get(normalized);
      if (tail?.token === token) {
        this.tails.delete(normalized);
      }
    };
  }

  async acquireMany(paths: string[]): Promise<ReleaseLock> {
    const normalized = Array.from(new Set(paths.map((item) => normalizePath(item)))).sort((a, b) =>
      a.localeCompare(b)
    );
    const releases: ReleaseLock[] = [];
    try {
      for (const key of normalized) {
        releases.push(await this.acquire(key));
      }
      return () => {
        for (let i = releases.length - 1; i >= 0; i -= 1) {
          releases[i]();
        }
      };
    } catch (error) {
      for (let i = releases.length - 1; i >= 0; i -= 1) {
        releases[i]();
      }
      throw error;
    }
  }
}

function normalizePath(targetPath: string): string {
  return path.resolve(targetPath).toLowerCase();
}

const globalFileLockRegistry = new FileLockRegistry();

export async function withFileLocks<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
  const release = await globalFileLockRegistry.acquireMany(paths);
  try {
    return await operation();
  } finally {
    release();
  }
}

