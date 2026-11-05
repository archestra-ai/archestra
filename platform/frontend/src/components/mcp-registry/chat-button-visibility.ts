/**
 * Decides whether an MCP registry card shows its "Chat" button.
 *
 * The button must not appear just because the catalog item has discovered
 * tools: a catalog item's tool rows are keyed by catalog id and are
 * deliberately retained when its installations are removed (so reconnecting
 * restores assignments/policies — see `McpServerModel.delete`). So
 * `toolsCount > 0` survives uninstall and is NOT a reliable signal that
 * there is anything to chat with.
 *
 * Chat routes through the gateway, which resolves a catalog tool to a
 * concrete install at call time (`pickInstallForCaller`): the caller's
 * personal install, then a team install of a team they belong to, then an
 * org-scoped install. With zero reachable installs the call dead-ends in an
 * `auth_required` error. So a non-builtin card only offers Chat when an
 * installation reachable by the viewer exists.
 *
 * The built-in (Archestra) server is the exception: it has no install rows
 * and is always available, so it stays chat-enabled whenever it has tools.
 */
export function shouldShowMcpCardChatButton({
  toolsCount,
  isBuiltin,
  hasInstallation,
}: {
  /** Discovered tools for the catalog item (`item.toolCount`). */
  toolsCount: number;
  /** The Archestra built-in MCP server (card variant `"builtin"`). */
  isBuiltin: boolean;
  /** An installation for this catalog item is reachable by the viewer. */
  hasInstallation: boolean;
}): boolean {
  return toolsCount > 0 && (isBuiltin || hasInstallation);
}
