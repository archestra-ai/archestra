export function getCostsNavigationUrl(
  permissionMap: Partial<Record<string, boolean>> | null | undefined,
): "/llm/costs" | "/llm/limits" {
  return permissionMap?.["/llm/costs"] === false &&
    permissionMap["/llm/limits"] === true
    ? "/llm/limits"
    : "/llm/costs";
}
