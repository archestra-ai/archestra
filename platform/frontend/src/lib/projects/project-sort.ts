export function sortProjectsPinnedFirst<T extends { pinnedAt: string | null }>(
  projects: T[],
): T[] {
  return [...projects].sort((a, b) => {
    if (!!a.pinnedAt !== !!b.pinnedAt) return a.pinnedAt ? -1 : 1;
    if (!a.pinnedAt || !b.pinnedAt) return 0;
    return Date.parse(b.pinnedAt) - Date.parse(a.pinnedAt);
  });
}
