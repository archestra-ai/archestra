import {
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  slugifyMcpServerName,
} from "@archestra/shared";

export const ARCHESTRA_DOCS_SERVER_NAME = "Archestra Docs"; // white-label-ok: names the vendor's public docs site
export const OPENAPPA_DOCS_SERVER_NAME = "OpenAPPA Docs";

/** What each docs server serves. */
const DOCS_TOOLS = ["list_docs", "read_doc", "search_docs"] as const;

/**
 * The docs servers' tools under the names a gateway gives them. The starting
 * Guardrails policy names each one, so reading public documentation is ruled
 * the same way every time and not labelled by a model call by call.
 */
export const DOCS_MCP_TOOL_NAMES: readonly string[] = [
  ARCHESTRA_DOCS_SERVER_NAME,
  OPENAPPA_DOCS_SERVER_NAME,
].flatMap((server) =>
  DOCS_TOOLS.map(
    (tool) =>
      `${slugifyMcpServerName(server)}${MCP_SERVER_TOOL_NAME_SEPARATOR}${tool}`,
  ),
);
