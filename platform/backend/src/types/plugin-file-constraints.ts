export const PLUGIN_MAX_FILES = 100;
export const PLUGIN_MAX_FILE_BYTES = 750 * 1024;
export const PLUGIN_MAX_TOTAL_BYTES = 5 * 1024 * 1024;

export function isSafePluginPath(value: string): boolean {
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    return false;
  }
  return !value
    .split("/")
    .some((segment) => segment === "." || segment === "..");
}
