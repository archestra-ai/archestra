export function getUsageNavigationLabel(
  permissionMap: Partial<Record<string, boolean>> | null | undefined,
): "My Usage" | "Usage & Costs" {
  if (
    permissionMap?.["/llm/costs"] === false &&
    permissionMap["/llm/limits"] === false
  ) {
    return "My Usage";
  }

  return "Usage & Costs";
}
