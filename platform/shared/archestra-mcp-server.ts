/**
 * Constants related to the Archestra built-in MCP server tools.
 * Shared across backend, frontend, and e2e-tests.
 */

/** The namespace prefix used for all Archestra built-in MCP tools */
export const ARCHESTRA_MCP_TOOL_PREFIX = "archestra__";

/** Full name of the built-in tool that swaps back to the default agent */
export const TOOL_SWAP_TO_DEFAULT_AGENT_FULL_NAME =
  `${ARCHESTRA_MCP_TOOL_PREFIX}swap_to_default_agent`;

/** Full name of the built-in tool that delegates work to a sub-agent */
export const TOOL_DELEGATE_TO_AGENT_FULL_NAME =
  `${ARCHESTRA_MCP_TOOL_PREFIX}delegate_to_agent`;