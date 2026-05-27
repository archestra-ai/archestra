/**
 * Catalog edits whose ONLY changed fields are in this set skip the
 * reinstall cascade. Pure display/metadata only — no effect on pod
 * spec, env, args, image, transport, auth, or wire behavior.
 *
 * SAFETY: adding a wrong field lets runtime-affecting edits silently
 * skip the cascade (installed servers drift, no UI hint). Removing a
 * field is harmless — just loses the optimization.
 */
export const METADATA_ONLY_CATALOG_FIELDS = ["description", "labels"] as const;

/**
 * Keys ignored during comparison: DB-managed columns the caller didn't
 * write, and derived display fields that may or may not be populated
 * depending on which read path produced the snapshot (e.g. `authorName`
 * from `populateAuthorNames`, `toolCount` from `attachListMetadata`).
 */
const IGNORED_DURING_COMPARISON = new Set<string>([
  "createdAt",
  "updatedAt",
  "id",
  "organizationId",
  "authorId",
  "authorName",
  "toolCount",
]);

/**
 * Returns true iff every diff between `prev` and `next` is in
 * `METADATA_ONLY_CATALOG_FIELDS`. False if nothing diffs at all.
 *
 * Iterates `Object.keys(next)` only so frontend PATCH-shaped payloads
 * don't trip on absent DB columns. Vanilla `JSON.stringify` per key —
 * any shape drift in a non-metadata field falls back to `false` (modal
 * fires, cascade runs), which is the pre-fix baseline. No path here
 * leads to a missed reinstall.
 */
export function isMetadataOnlyEdit(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  const metadataKeys = new Set<string>(METADATA_ONLY_CATALOG_FIELDS);
  let metadataDiffFound = false;
  for (const key of Object.keys(next)) {
    if (IGNORED_DURING_COMPARISON.has(key)) continue;
    if (JSON.stringify(prev[key]) === JSON.stringify(next[key])) continue;
    if (!metadataKeys.has(key)) return false;
    metadataDiffFound = true;
  }
  return metadataDiffFound;
}
