/**
 * Joins a provider base URL with a request path, tolerating a trailing slash on
 * the base. A base URL like `https://api.anthropic.com/` would otherwise
 * concatenate to `…//v1/models`, which providers reject with a 404. `path`
 * carries its own leading slash and any query string.
 */
export function joinBaseUrl(
  baseUrl: string | null | undefined,
  path: string,
): string {
  return `${(baseUrl ?? "").replace(/\/+$/, "")}${path}`;
}
