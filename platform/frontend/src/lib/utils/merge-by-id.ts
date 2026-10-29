/** Rows of every source, each id once; the first source holding an id wins. */
export function mergeById<T extends { id: string }>(
  ...sources: Array<readonly T[] | undefined>
): T[] {
  const byId = new Map<string, T>();
  for (const source of sources) {
    for (const row of source ?? []) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}
