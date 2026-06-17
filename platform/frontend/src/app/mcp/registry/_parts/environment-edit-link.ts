export const ENVIRONMENT_EDIT_PARAM = "edit";
export const ENVIRONMENT_CREATE_PARAM = "create";
// Sentinel `edit` value for the org-level default environment, which is a
// virtual row (id `"default"`) rather than a real uuid environment.
export const ENVIRONMENT_DEFAULT_VALUE = "default";

/**
 * Search string (without leading `?`) with `?edit=<id>` set, preserving other
 * params, so an open environment editor is shareable via the address bar. The
 * `create` param is removed since the two dialogs are mutually exclusive.
 */
export function setEnvironmentEditParam(
  currentSearch: string,
  id: string,
): string {
  const params = new URLSearchParams(currentSearch);
  params.delete(ENVIRONMENT_CREATE_PARAM);
  params.set(ENVIRONMENT_EDIT_PARAM, id);
  return params.toString();
}

/**
 * Search string with `?create` set, preserving other params and removing
 * `edit` (the dialogs are mutually exclusive).
 */
export function setEnvironmentCreateParam(currentSearch: string): string {
  const params = new URLSearchParams(currentSearch);
  params.delete(ENVIRONMENT_EDIT_PARAM);
  params.set(ENVIRONMENT_CREATE_PARAM, "1");
  return params.toString();
}

/**
 * Search string with both dialog params removed, preserving other params. Used
 * when a dialog closes or an unknown `edit` id is ignored.
 */
export function clearEnvironmentDialogParams(currentSearch: string): string {
  const params = new URLSearchParams(currentSearch);
  params.delete(ENVIRONMENT_EDIT_PARAM);
  params.delete(ENVIRONMENT_CREATE_PARAM);
  return params.toString();
}
