export interface OrchestratorMessageRouteEventPair<TEvent = unknown> {
  received: TEvent;
  routed: TEvent;
}

export async function appendOrchestratorMessageRouteEventPair<TEvent>(
  appendEvent: (event: TEvent) => Promise<void>,
  pair: OrchestratorMessageRouteEventPair<TEvent>
): Promise<void> {
  await appendEvent(pair.received);
  await appendEvent(pair.routed);
}
