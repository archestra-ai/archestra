/**
 * Pure URL transitions for the /skills editor dialog deep link.
 *
 * The open editor is driven by an `edit=<skillId>` search param that stays in
 * the URL while the dialog is open, so the link is copyable at any moment
 * (deliberate divergence from pages that strip the param after opening).
 * Every function returns a new URLSearchParams and leaves its input untouched,
 * preserving all unrelated params (page, pageSize, search, sourceRepo, ...).
 */

export function withEditorOpen(
  params: URLSearchParams,
  skillId: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set("edit", skillId);
  return next;
}

export function withEditorClosed(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("edit");
  return next;
}

/**
 * Rewrites a legacy `openEdit=<name>` deep link (resolved to a skill id by the
 * caller) into the durable `edit=<skillId>` form.
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
