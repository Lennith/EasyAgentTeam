const TERMINAL_DEPENDENCY_STATES = new Set(["DONE", "CANCELED"]);
const DEFAULT_ALLOWED_WHEN_UNREADY = new Set(["BLOCKED_DEP", "CANCELED"]);

export function isOrchestratorDependencyResolved(state: string | undefined): boolean {
  if (!state) {
    return false;
  }
  return TERMINAL_DEPENDENCY_STATES.has(state);
}

export function collectOrchestratorUnreadyDependencyIds(
  dependencyIds: Iterable<string>,
  resolveDependencyState: (dependencyId: string) => string | undefined
): string[] {
  const unresolved: string[] = [];
  for (const dependencyId of dependencyIds) {
    const dependencyState = resolveDependencyState(dependencyId);
    if (!isOrchestratorDependencyResolved(dependencyState)) {
      unresolved.push(dependencyId);
    }
  }
  return unresolved;
}

export function requiresOrchestratorReadyDependencies(
  targetState: string,
  allowedWhenUnready: ReadonlySet<string> = DEFAULT_ALLOWED_WHEN_UNREADY
): boolean {
  return !allowedWhenUnready.has(targetState);
}
