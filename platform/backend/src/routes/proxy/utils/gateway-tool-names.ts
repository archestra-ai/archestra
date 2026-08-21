import {
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  toMcpClientServerName,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
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
export async function buildGatewayToolNameCanonicalizer(params: {
  organizationId: string;
  /**
   * Every tool name the caller declared in this request. Used to learn the
   * client's own label for the gateway when it is not one the organization
   * knows — see {@link learnGatewayDecorationPrefixes}.
   */
  declaredToolNames?: readonly string[];
}): Promise<ToolNameCanonicalizer> {
  const { organizationId, declaredToolNames = [] } = params;
  const serverNames = await getGatewayServerNames(organizationId);
  const learnedPrefixes = learnGatewayDecorationPrefixes(declaredToolNames);
  if (serverNames.size === 0 && learnedPrefixes.length === 0) {
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
    return stripLearnedDecoration(toolName, learnedPrefixes);
  };
}

// === Internal helpers ===

/**
 * The client-side decoration prefixes that belong to one of our gateways,
 * learned from the caller's own declared tool list.
 *
 * The anchor the loop above uses — matching the label against a gateway name
 * the organization knows — assumes the client registered the gateway under the
 * name the connection-setup script derives. Nothing enforces that: the label is
 * whatever the person who ran `claude mcp add <label> <url>` typed, so it is
 * routinely something else entirely, and then no label matches at any index and
 * every decorated name survives untouched. Guardrails downstream reason about
 * the decoration instead of the tool, and policy lookups miss the row that
 * speaks for it.
 *
 * A client namespaces every tool from ONE server with the SAME prefix, so the
 * prefix is identifiable from evidence rather than convention: whichever prefix
 * a request's tool list carries in front of one of *our* branded tool names is
 * that request's decoration for our gateway. That is per-request, and it names
 * a prefix rather than trusting a name — a server can only ever claim its own
 * prefix, never another server's.
 *
 * Which bounds the spoof this anchoring exists to prevent. A hostile MCP server
 * connected straight to the client can put our branded name on its own tools
 * and so claim its own prefix — but claiming it only causes ITS names to be
 * stripped to `<server>__<tool>`, which is then looked up and policy-evaluated
 * like any other tool. That is strictly more enforcement than the untouched
 * name it gets today, which matches no row and is evaluated by nothing. The one
 * thing it must not buy is built-in status, since built-ins bypass policy — so
 * {@link stripLearnedDecoration} refuses to hand back a branded name. Built-in
 * recognition keeps requiring the strict, unlearned anchor above.
 */
function learnGatewayDecorationPrefixes(
  declaredToolNames: readonly string[],
): string[] {
  const prefixes = new Set<string>();
  for (const toolName of declaredToolNames) {
    const segments = toolName.split(MCP_SERVER_TOOL_NAME_SEPARATOR);
    // Start at 1: a zero-length prefix is an undecorated name, which the strict
    // path already handles and which must not turn every name into a match.
    for (let i = 1; i < segments.length; i++) {
      const remainder = segments.slice(i).join(MCP_SERVER_TOOL_NAME_SEPARATOR);
      if (archestraMcpBranding.isToolName(remainder)) {
        prefixes.add(
          segments.slice(0, i).join(MCP_SERVER_TOOL_NAME_SEPARATOR) +
            MCP_SERVER_TOOL_NAME_SEPARATOR,
        );
        break;
      }
    }
  }
  // Longest first, so the most specific decoration wins when one prefix is a
  // prefix of another.
  return [...prefixes].sort((a, b) => b.length - a.length);
}

/**
 * Strip a learned decoration prefix, refusing to produce a branded built-in
 * name.
 *
 * Built-ins bypass tool-invocation and trusted-data policies, so granting that
 * status on the strength of a learned prefix would let a hostile server opt its
 * own tools out of enforcement by naming them after ours. Everything else the
 * prefix reveals is a third-party tool name that gets looked up and policied,
 * which is the point. The `run_tool` wrapper does not need this path — it is
 * recognized through the decoration by `resolveRunToolDispatch`, which only
 * unwraps a dispatch so the target is policy-evaluated and never confers bypass
 * either.
 */
function stripLearnedDecoration(
  toolName: string,
  learnedPrefixes: readonly string[],
): string {
  for (const prefix of learnedPrefixes) {
    if (!toolName.startsWith(prefix)) {
      continue;
    }
    const remainder = toolName.slice(prefix.length);
    if (remainder === "" || archestraMcpBranding.isToolName(remainder)) {
      return toolName;
    }
    return remainder;
  }
  return toolName;
}

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
