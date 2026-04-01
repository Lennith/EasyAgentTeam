export type OrchestratorEnvSource = Record<string, string | undefined>;

function getFirstDefinedEnvValue(names: readonly string[], env: OrchestratorEnvSource): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export function resolveBooleanEnvFlag(
  names: readonly string[],
  defaultValue: boolean,
  env: OrchestratorEnvSource = process.env
): boolean {
  const raw = getFirstDefinedEnvValue(names, env);
  if (raw === undefined) {
    return defaultValue;
  }
  return String(raw).trim() !== "0";
}

export function resolveIntegerEnvValue(
  names: readonly string[],
  defaultValue: number,
  isValid: (value: number) => boolean,
  env: OrchestratorEnvSource = process.env
): number {
  const raw = getFirstDefinedEnvValue(names, env);
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !isValid(parsed)) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

export function resolveNumberEnvValue(
  names: readonly string[],
  defaultValue: number,
  isValid: (value: number) => boolean,
  env: OrchestratorEnvSource = process.env
): number {
  const raw = getFirstDefinedEnvValue(names, env);
  if (raw === undefined) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !isValid(parsed)) {
    return defaultValue;
  }
  return parsed;
}
