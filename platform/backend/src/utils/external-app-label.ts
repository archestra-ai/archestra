/**
 * Display label for an external (MCP-server) UI app. A server exposing a
 * single UI tool is just the server: title it by the server name alone. The
 * "<server> / <tool>" form only appears when one server exposes several UI
 * tools and its cards/resources need disambiguating. `uiToolCount` counts the
 * server's UI tools overall (never a search-filtered subset), so a label is
 * stable across listings.
 */
export function externalAppLabel(params: {
  serverName: string;
  toolName: string;
  uiToolCount: number;
}): string {
  return params.uiToolCount > 1
    ? `${params.serverName} / ${params.toolName}`
    : params.serverName;
}
