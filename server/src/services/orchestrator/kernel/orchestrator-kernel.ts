export interface OrchestratorKernelAdapter<TContext> {
  listContexts: () => Promise<readonly TContext[]>;
  tickContext: (context: TContext) => Promise<void>;
}

export class OrchestratorKernel {
  async runTick<TContext>(adapter: OrchestratorKernelAdapter<TContext>): Promise<void> {
    await runOrchestratorKernelTick(adapter);
  }
}

export function buildOrchestratorContextSessionKey(contextId: string, sessionId: string): string {
  return `${contextId}::${sessionId}`;
}

export async function runOrchestratorKernelTick<TContext>(adapter: OrchestratorKernelAdapter<TContext>): Promise<void> {
  const contexts = await adapter.listContexts();
  for (const context of contexts) {
    await adapter.tickContext(context);
  }
}
