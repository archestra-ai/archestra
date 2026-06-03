import { MCP_CATALOG_EDIT_QUERY_PARAM } from "@shared";

/**
 * Search string (without leading `?`) with `?edit=<id>` set, preserving all
 * other params. Used to make an open editor shareable via the address bar.
 */
export function setCatalogEditParam(currentSearch: string, id: string): string {
  const params = new URLSearchParams(currentSearch);
  params.set(MCP_CATALOG_EDIT_QUERY_PARAM, id);
  return params.toString();
}

/**
 * Search string (without leading `?`) with `?edit` removed, preserving all
 * other params. Used when the editor closes or an unknown id is ignored.
 */
export function clearCatalogEditParam(currentSearch: string): string {
  const params = new URLSearchParams(currentSearch);
  params.delete(MCP_CATALOG_EDIT_QUERY_PARAM);
  return params.toString();
}
