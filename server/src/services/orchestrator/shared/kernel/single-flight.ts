export class OrchestratorSingleFlightGate {
  private readonly keys = new Set<string>();

  get size(): number {
    return this.keys.size;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    this.keys.add(key);
  }

  tryAdd(key: string): boolean {
    if (this.keys.has(key)) {
      return false;
    }
    this.keys.add(key);
    return true;
  }

  delete(key: string): void {
    this.keys.delete(key);
  }

  clear(): void {
    this.keys.clear();
  }

  values(): IterableIterator<string> {
    return this.keys.values();
  }

  snapshot(): string[] {
    return Array.from(this.keys);
  }

  prune(predicate: (key: string) => boolean): void {
    for (const key of this.keys) {
      if (predicate(key)) {
        this.keys.delete(key);
      }
    }
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.keys.values();
  }
}
