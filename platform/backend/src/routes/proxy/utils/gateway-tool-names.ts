import {
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  toMcpClientServerName,
} from "@archestra/shared";
import { resolveRunToolTargetName } from "@/archestra-mcp-server/run-tool-target";
import { LRUCacheManager } from "@/cache-manager";
import { AgentModel } from "@/models";

/**
 * Maps a tool name as an external MCP client presents it to the canonical
 * name the platform knows it by, or returns it unchanged when it is not a
 * decorated gateway tool name.
 */
export type ToolNameCanonicalizer = (toolName: string) => string;

/**
 * Build a canonicalizer for tool names decorated by external MCP clients.
 *
 * A client connected to an MCP gateway namespaces the gateway's tools with
 * its own label when presenting them to the model — Claude Code turns
 * `archestra__run_tool` into `mcp__<server_name>__archestra__run_tool`, where
 * `<server_name>` is the name the gateway was registered under. Those
 * decorated names are what reach the LLM proxy in tool definitions, tool
 * results, and tool calls, and they match neither the built-in recognizers
 * nor any `tools` row — so guardrail evaluation used to find nothing to
 * enforce (tool-invocation policies fail open on an unknown name).
 *
 * The decoration is only stripped when the label segment is the client server
 * name of one of the organization's own gateways (`toMcpClientServerName` of
 * a live gateway-capable agent). Anchoring on the org's real gateway names is
 * what keeps this safe: a hostile MCP server connected directly to the client
 * cannot get its tools canonicalized into platform built-ins or policied
 * tools by merely naming them to look like ours — its label won't match a
 * gateway, so its tools keep their foreign names and stay on the fail-closed
 * paths (unknown result = untrusted context, discovered-tool policies).
 *
 * A bare built-in short name left after stripping (a client that decorates
 * the listed name down to its short form) is expanded to the full built-in
 * name, mirroring run_tool's own dispatch resolution.
 */
export async function buildGatewayToolNameCanonicalizer(
  organizationId: string,
): Promise<ToolNameCanonicalizer> {
  const serverNames = await getGatewayServerNames(organizationId);
  if (serverNames.size === 0) {
    return (toolName) => toolName;
  }

  return (toolName) => {
    const segments = toolName.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
    // The gateway's server-name label sits first, or second behind a fixed
    // client prefix (Claude Code's `mcp`). Require at least one segment after
    // the label to form the canonical name.
    const labelLimit = Math.min(
      GATEWAY_LABEL_MAX_INDEX + 1,
      segments.length - 1,
    );
    for (let i = 0; i < labelLimit; i++) {
      if (!serverNames.has(segments[i])) {
        continue;
      }
      const canonicalName = segments
        .slice(i + 1)
        .join(MCP_SERVER_TOOL_NAME_SEPARATOR);
      return resolveRunToolTargetName(canonicalName);
    }
    return toolName;
  };
}

// === Internal helpers ===

/** How deep into the segments a client's gateway label may sit (0 or 1). */
const GATEWAY_LABEL_MAX_INDEX = 1;

async function getGatewayServerNames(
  organizationId: string,
): Promise<Set<string>> {
  const cached = gatewayServerNamesCache.get(organizationId);
  if (cached) {
    return cached;
  }
  const gatewayNames =
    await AgentModel.findGatewayNamesByOrganizationId(organizationId);
  const serverNames = new Set(
    gatewayNames.map(toMcpClientServerName).filter(Boolean),
  );
  gatewayServerNamesCache.set(organizationId, serverNames);
  return serverNames;
}

/**
 * Per-organization cache of gateway client server names. Gateway renames are
 * rare; a short TTL keeps proxy requests from querying agents on every call.
 */
const gatewayServerNamesCache = new LRUCacheManager<Set<string>>({
  maxSize: 500,
  defaultTtl: 60_000,
});
