import { archestraMcpBranding } from "./branding";

/**
 * Per-conversation enabled-tool gate shared by search_tools and run_tool.
 *
 * `enabledNames` is the set of tool NAMES the conversation enabled
 * (`ConversationEnabledToolModel.getEnabledToolNameSet`), or `null` when there
 * is no custom selection — in which case nothing is filtered.
 *
 * Mirrors the visible-list rule in `clients/chat-mcp-client.ts`
 * (`filterToolsByEnabledIds`): a tool is allowed iff it is an Archestra
 * built-in (always available — these are the platform/runtime surface and keep
 * search_tools/run_tool themselves reachable) or its name is in the enabled
 * set. Third-party MCP tools and agent-delegation tools require membership.
 *
 * Deliberate divergence from that function's `empty-array ⇒ {}` edge: under an
 * empty custom selection Archestra built-ins still pass here, so the agent can
 * never lock itself out of the meta-tools. The selector governs connected MCP
 * and delegation tools, not Archestra platform tools.
 *
 * Invariant: callers derive `enabledNames` from a server-set `conversationId`
 * (never a model-supplied value). `null` means there is no conversation-scoped
 * selection to apply — no custom selection, or a non-chat context such as an
 * external MCP gateway session — not "filtering disabled by the caller".
 */
export function isToolEnabledForConversation(
  toolName: string,
  enabledNames: Set<string> | null,
): boolean {
  if (enabledNames === null) {
    return true;
  }
  return (
    archestraMcpBranding.isToolName(toolName) || enabledNames.has(toolName)
  );
}
