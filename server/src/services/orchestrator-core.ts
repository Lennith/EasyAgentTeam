export interface OrchestratorLoopCoreOptions {
  enabled: boolean;
  intervalMs: number;
  onTick: () => Promise<void>;
  onError?: (error: unknown) => void;
}

export interface OrchestratorLoopSnapshot {
  enabled: boolean;
  running: boolean;
  started: boolean;
  intervalMs: number;
  tickRunning: boolean;
  lastTickAt: string | null;
}

export interface OrchestratorAdapter<TContext> {
  listContexts: () => Promise<readonly TContext[]>;
  tickContext: (context: TContext) => Promise<void>;
}

export class OrchestratorLoopCore {
  private timer: NodeJS.Timeout | null = null;
  private tickRunning = false;
  private started = false;
  private lastTickAt: string | null = null;

  constructor(private readonly options: OrchestratorLoopCoreOptions) {}

  start(): void {
    this.started = true;
    if (!this.options.enabled || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tickOnce(): Promise<void> {
    if (!this.options.enabled || this.tickRunning) {
      return;
    }
    this.tickRunning = true;
    try {
      await this.options.onTick();
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.lastTickAt = new Date().toISOString();
      this.tickRunning = false;
    }
  }

  getSnapshot(): OrchestratorLoopSnapshot {
    return {
      enabled: this.options.enabled,
      running: this.timer !== null,
      started: this.started,
      intervalMs: this.options.intervalMs,
      tickRunning: this.tickRunning,
      lastTickAt: this.lastTickAt
    };
  }
}

export function buildOrchestratorContextSessionKey(contextId: string, sessionId: string): string {
  return `${contextId}::${sessionId}`;
}

export async function runOrchestratorAdapterTick<TContext>(adapter: OrchestratorAdapter<TContext>): Promise<void> {
  const contexts = await adapter.listContexts();
  for (const context of contexts) {
    await adapter.tickContext(context);
  }
}
