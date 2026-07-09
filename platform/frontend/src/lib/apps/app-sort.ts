/** Pinned apps first (newest pin first), mirroring sortProjectsPinnedFirst. */
export function sortAppsPinnedFirst<T extends { pinnedAt: string | null }>(
  apps: T[],
): T[] {
  return [...apps].sort((a, b) => {
    if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
    if (!a.pinnedAt || !b.pinnedAt) return 0;
    return Date.parse(b.pinnedAt) - Date.parse(a.pinnedAt);
  });
}
