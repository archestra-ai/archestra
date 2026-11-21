/**
 * Cost Controls is one row over two pages; it opens Limits unless the reader
 * may see only Exports.
 */
export function getCostControlsNavigationUrl(
  permissionMap: Partial<Record<string, boolean>> | null | undefined,
): "/llm/limits" | "/llm/cost-exports" {
  return permissionMap?.["/llm/limits"] === false &&
    permissionMap["/llm/cost-exports"] === true
    ? "/llm/cost-exports"
    : "/llm/limits";
}
