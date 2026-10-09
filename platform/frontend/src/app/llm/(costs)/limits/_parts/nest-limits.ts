/**
 * Orders limits as a tree: each limit sits under the limit that also applies
 * to the same requests (a key under its billing team, a team under the
 * organization), so the table reads top-down as "who pays for what".
 *
 * A limit whose parent is filtered out, or has no limit of its own, becomes a
 * root. Siblings keep their input order.
 */
export function nestLimits<T extends NestableLimit>({
  limits,
  entityKeyOf,
  parentKeysOf,
  prefersAsParent = () => false,
}: {
  limits: T[];
  /** Identifies the entity a limit applies to, e.g. `team:<id>`. */
  entityKeyOf: (limit: T) => string;
  /** Candidate parent entity keys, nearest first. */
  parentKeysOf: (limit: T) => string[];
  /** Picks which of an entity's limits its children nest under. */
  prefersAsParent?: (limit: T) => boolean;
}): NestedLimit<T>[] {
  const parentByEntity = new Map<string, T>();
  for (const limit of limits) {
    const key = entityKeyOf(limit);
    const current = parentByEntity.get(key);
    if (!current || (!prefersAsParent(current) && prefersAsParent(limit))) {
      parentByEntity.set(key, limit);
    }
  }

  const childrenById = new Map<string, T[]>();
  const roots: T[] = [];
  for (const limit of limits) {
    const parent = parentKeysOf(limit)
      .map((key) => parentByEntity.get(key))
      .find((candidate) => candidate && candidate.id !== limit.id);
    if (!parent) {
      roots.push(limit);
      continue;
    }
    const siblings = childrenById.get(parent.id) ?? [];
    siblings.push(limit);
    childrenById.set(parent.id, siblings);
  }

  const ordered: NestedLimit<T>[] = [];
  const visit = (limit: T, depth: number) => {
    const children = childrenById.get(limit.id) ?? [];
    ordered.push({
      limit,
      depth,
      children,
      allocation: children.length > 0 ? allocate(limit, children) : null,
    });
    for (const child of children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return ordered;
}

export type NestedLimit<T> = {
  limit: T;
  depth: number;
  /** Limits nested directly under this one. */
  children: T[];
  /** How much of this limit its direct children's caps take. */
  allocation: LimitAllocation | null;
};

export type LimitAllocation = {
  /** Sum of the children's caps that reset on this limit's period. */
  total: number;
  /** Children counted in `total`. */
  count: number;
  /** Children whose caps reset on another period, so they are not summed. */
  otherPeriodCount: number;
};

type NestableLimit = {
  id: string;
  limitValue: number;
  cleanupInterval?: string | null;
};

// Caps on different periods cannot be added together: a weekly $500 and a
// monthly $800 measure different windows.
function allocate<T extends NestableLimit>(
  parent: T,
  children: T[],
): LimitAllocation {
  const samePeriod = children.filter(
    (child) => child.cleanupInterval === parent.cleanupInterval,
  );
  return {
    total: samePeriod.reduce((sum, child) => sum + child.limitValue, 0),
    count: samePeriod.length,
    otherPeriodCount: children.length - samePeriod.length,
  };
}
