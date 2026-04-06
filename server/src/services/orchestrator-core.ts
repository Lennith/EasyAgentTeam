import {
  buildOrchestratorContextSessionKey,
  runOrchestratorKernelTick,
  type OrchestratorKernelAdapter
} from "./orchestrator/shared/kernel/orchestrator-kernel.js";

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

export type OrchestratorAdapter<TContext> = OrchestratorKernelAdapter<TContext>;

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

export { buildOrchestratorContextSessionKey };

export async function runOrchestratorAdapterTick<TContext>(adapter: OrchestratorAdapter<TContext>): Promise<void> {
  await runOrchestratorKernelTick(adapter);
}
