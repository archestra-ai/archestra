/** Settings → Agents → Runtimes. */
const RUNTIME_SETTINGS_PATH = "/settings/agents/runtimes";

/**
 * The query parameter that names the runtime whose editor that page opens:
 * a maintained runtime's id, or a custom runtime's own.
 */
export const RUNTIME_EDIT_PARAM = "edit";

/**
 * Where a runtime is administered: the Runtimes settings page, on that
 * runtime's editor when one is named.
 */
export function runtimeSettingsHref(runtimeId?: string | null): string {
  return runtimeId
    ? `${RUNTIME_SETTINGS_PATH}?${new URLSearchParams({ [RUNTIME_EDIT_PARAM]: runtimeId })}`
    : RUNTIME_SETTINGS_PATH;
}
