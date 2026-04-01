import type { ResolvedProjectRepositoryScope } from "../../data/repository/project-repository-bundle.js";
import { getProjectRepositoryBundle } from "../../data/repository/project-repository-bundle.js";

export function runTaskActionWriteContext<T>(
  dataRoot: string,
  scope: ResolvedProjectRepositoryScope,
  operation: () => Promise<T>
): Promise<T> {
  return getProjectRepositoryBundle(dataRoot).runInUnitOfWork(scope, operation);
}
