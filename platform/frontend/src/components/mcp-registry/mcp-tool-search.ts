// Case-insensitive filter over MCP tools by name or description, used by the
// inspector's tools sidebar search.
export function filterMcpTools<
  T extends { name: string; description?: string },
>(tools: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return tools;
  return tools.filter(
    (tool) =>
      tool.name.toLowerCase().includes(normalized) ||
      tool.description?.toLowerCase().includes(normalized),
  );
}
