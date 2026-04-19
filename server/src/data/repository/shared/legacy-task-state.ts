const LEGACY_AMBIGUOUS_DONE_ALIAS = ["MAY", "BE", "DONE"].join("_");

function normalizeLegacyAlias(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase() : "";
}

export function isLegacyAmbiguousDoneState(raw: unknown): boolean {
  return normalizeLegacyAlias(raw) === LEGACY_AMBIGUOUS_DONE_ALIAS;
}
