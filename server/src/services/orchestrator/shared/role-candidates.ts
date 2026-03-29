export interface CollectOrchestratorRoleSetInput {
  explicitRole?: string | null;
  sessionRoles?: Iterable<string | null | undefined>;
  taskOwnerRoles?: Iterable<string | null | undefined>;
  mappedRoles?: Iterable<string | null | undefined>;
}

function normalizeRole(role: string | null | undefined): string | null {
  if (typeof role !== "string") {
    return null;
  }
  const normalized = role.trim();
  return normalized.length > 0 ? normalized : null;
}

export function collectOrchestratorRoleSet(input: CollectOrchestratorRoleSetInput): Set<string> {
  const explicitRole = normalizeRole(input.explicitRole);
  if (explicitRole) {
    return new Set([explicitRole]);
  }

  const roleSet = new Set<string>();
  for (const role of input.sessionRoles ?? []) {
    const normalized = normalizeRole(role);
    if (normalized) {
      roleSet.add(normalized);
    }
  }
  for (const role of input.taskOwnerRoles ?? []) {
    const normalized = normalizeRole(role);
    if (normalized) {
      roleSet.add(normalized);
    }
  }
  for (const role of input.mappedRoles ?? []) {
    const normalized = normalizeRole(role);
    if (normalized) {
      roleSet.add(normalized);
    }
  }
  return roleSet;
}

export function sortOrchestratorRoles(roles: Iterable<string>): string[] {
  return Array.from(roles).sort((left, right) => left.localeCompare(right));
}
