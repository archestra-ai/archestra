/**
 * Rewrites a legacy `openEdit=<name>` deep link (resolved to a skill id by the
 * caller) into the durable `edit=<skillId>` form managed by
 * `useDialogUrlParam`. Returns a new URLSearchParams and leaves its input
 * untouched, preserving all unrelated params (page, pageSize, search,
 * sourceRepo, ...).
 */
export function withOpenEditRewritten(
  params: URLSearchParams,
  skillId: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("openEdit");
  next.set("edit", skillId);
  return next;
}
