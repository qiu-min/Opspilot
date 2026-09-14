/** Resource kinds that a Session can know about. */
export type SessionResourceKind = 'excel';

/** Lightweight registry reference; it deliberately contains no file state. */
export interface SessionResourceRef {
  readonly id: string;
  readonly kind: SessionResourceKind;
  /** Stable, Session-local name exposed to the model instead of the internal id. */
  readonly alias: string;
}

/** Input accepted while restoring older metadata or registering a new resource. */
export interface SessionResourceRefInput {
  readonly id: string;
  readonly kind: SessionResourceKind;
  readonly alias?: string;
}

/**
 * Fills missing aliases without changing aliases that are already persisted.
 * The first available excel-N slot is selected so holes and non-sequential
 * persisted aliases cannot cause a collision.
 */
export function assignSessionResourceAliases(
  resources: readonly SessionResourceRefInput[],
): SessionResourceRef[] {
  const usedAliases = new Set(
    resources.flatMap((resource) =>
      isNonEmptyString(resource.alias) ? [resource.alias.trim()] : [],
    ),
  );
  let nextNumber = 1;

  return resources.map((resource) => {
    const alias = isNonEmptyString(resource.alias)
      ? resource.alias.trim()
      : nextAvailableAlias(usedAliases, nextNumber);
    if (!isNonEmptyString(resource.alias)) {
      usedAliases.add(alias);
      nextNumber = Number(alias.slice('excel-'.length)) + 1;
    }
    return { id: resource.id, kind: resource.kind, alias };
  });
}

function nextAvailableAlias(usedAliases: ReadonlySet<string>, start: number): string {
  let number = start;
  while (usedAliases.has(`excel-${number}`)) number += 1;
  return `excel-${number}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
