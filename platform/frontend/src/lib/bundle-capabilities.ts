export function formatBundleCapabilitySummary({
  skillCount,
  pluginCount,
  localMcpCount,
}: {
  skillCount: number;
  pluginCount: number;
  localMcpCount: number;
}): string {
  const counts = [
    skillCount > 0 ? `${skillCount} skill${skillCount === 1 ? "" : "s"}` : null,
    pluginCount > 0
      ? `${pluginCount} plugin${pluginCount === 1 ? "" : "s"}`
      : null,
    localMcpCount > 0
      ? `${localMcpCount} local MCP${localMcpCount === 1 ? "" : "s"}`
      : null,
  ].filter((count): count is string => count !== null);

  return counts.length > 0 ? counts.join(" · ") : "No capabilities";
}
