/**
 * Pure selection math for a multi-select file list (shared by the chat and
 * project Files panels via `SelectableFileList`). Kept side-effect-free so it
 * can be unit-tested without rendering.
 */

/** Toggle one id in/out of the selection, returning a new set. */
export function toggleSelectedId(
  selectedIds: Set<string>,
  id: string,
): Set<string> {
  const next = new Set(selectedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** "Select all" / "deselect all": empties when all are checked, else selects all. */
export function selectAllIds(
  allChecked: boolean,
  managedIds: string[],
): Set<string> {
  return allChecked ? new Set() : new Set(managedIds);
}

/**
 * Drop selected ids whose files no longer exist (e.g. after a refetch), so the
 * count and "select all" stay honest. Returns the same set reference when
 * nothing changed, so it's safe to feed straight back into setState.
 */
export function pruneSelectedIds(
  selectedIds: Set<string>,
  managedIds: string[],
): Set<string> {
  if (selectedIds.size === 0) return selectedIds;
  const valid = new Set(managedIds);
  const next = new Set([...selectedIds].filter((id) => valid.has(id)));
  return next.size === selectedIds.size ? selectedIds : next;
}

/** Header checkbox state from how many of the managed files are selected. */
export function selectionCheckState(
  selectedCount: number,
  managedCount: number,
): { allChecked: boolean; someChecked: boolean } {
  const allChecked = managedCount > 0 && selectedCount === managedCount;
  const someChecked = selectedCount > 0 && !allChecked;
  return { allChecked, someChecked };
}
