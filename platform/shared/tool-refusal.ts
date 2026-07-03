import { DEFAULT_APP_NAME } from "./consts";

export const ARCHESTRA_TOOL_NAME_TAG = "archestra-tool-name";
export const ARCHESTRA_TOOL_ARGUMENTS_TAG = "archestra-tool-arguments";
export const ARCHESTRA_TOOL_REASON_TAG = "archestra-tool-reason";
// Bounds tag-parsing work on hostile or pathologically large inputs. Sized
// with headroom above the attributed refusal prose so large-but-legitimate
// tool arguments (which appear twice: in the tag block and in the prose) keep
// tag parsing instead of falling back to the looser heuristics.
const MAX_REFUSAL_METADATA_LENGTH = 60_000;

/** Which enforcement point blocked the call — named in the client-visible message. */
export type ToolInvocationEnforcementSurface = "llm-proxy" | "mcp-gateway";

const ENFORCEMENT_SURFACE_LABELS: Record<
  ToolInvocationEnforcementSurface,
  string
> = {
  "llm-proxy": "LLM Proxy",
  "mcp-gateway": "MCP Gateway",
};

// One-line description of what each surface does, so an unfamiliar reader
// understands why the call was stopped. The two surfaces sit at different
// points in the architecture: the LLM Proxy inspects the model's intended tool
// calls in the LLM traffic, while the MCP Gateway is the execution point that
// runs tool calls against MCP servers.
const ENFORCEMENT_SURFACE_DESCRIPTIONS: Record<
  ToolInvocationEnforcementSurface,
  string
> = {
  "llm-proxy":
    "monitors agentic traffic and blocks unsafe tool calls according to the configured guardrails",
  "mcp-gateway":
    "provides a single entry to the MCP servers and blocks unsafe tool calls according to the configured guardrails",
};

/**
 * Client-visible messages for a tool call blocked by a tool invocation policy.
 * `contentMessage` is the plain prose every transport shows (streaming SSE,
 * provider refusal responses); `refusalMessage` prepends the machine-parseable
 * `<archestra-tool-*>` tag block for transports that keep it (MCP gateway tool
 * results, OpenAI Responses refusal parts).
 *
 * The prose is load-bearing: parsePolicyDeniedMcpToolError (mcp-tool-error.ts)
 * extracts the tool name and arguments from the "blocked unsafe tool call:
 * <name> with arguments: {…}" header, and the reason as the paragraph that
 * immediately follows that header. So the header must stay one paragraph and
 * the reason the next.
 */
export function buildToolInvocationRefusalMessages(params: {
  toolName: string;
  toolArguments: string;
  reason: string;
  surface: ToolInvocationEnforcementSurface;
  /** Display name of the enforcing product; custom app name under full white-labeling. */
  productName?: string;
  /** Included so the user can hand their admin something to look up in the logs. */
  sessionId?: string;
}): { contentMessage: string; refusalMessage: string } {
  const { toolName, toolArguments, reason } = params;
  const productName = params.productName || DEFAULT_APP_NAME;
  const enforcer = `${productName} ${ENFORCEMENT_SURFACE_LABELS[params.surface]}`;
  const reasonLine = /[.!?]$/.test(reason.trim())
    ? reason.trim()
    : `${reason.trim()}.`;
  const sessionIdNote = params.sessionId
    ? `\nYour session id: ${params.sessionId}.`
    : "";

  const contentMessage = `
${enforcer} blocked unsafe tool call: ${toolName} with arguments: ${toolArguments}.

${reasonLine}

${enforcer} ${ENFORCEMENT_SURFACE_DESCRIPTIONS[params.surface]}.

If you believe this is a misconfiguration, contact your administrator.${sessionIdNote}`;

  const archestraMetadata = buildArchestraToolRefusalMetadata({
    toolName,
    toolArguments,
    reason,
  });

  return {
    contentMessage,
    refusalMessage: `${archestraMetadata}\n${contentMessage}`,
  };
}

/**
 * Replacement text for a tool result blocked by a trusted data policy. The
 * original content is removed from the request before it reaches the model, so
 * this notice is what the model (and the LLM logs UI) sees in its place.
 */
export function buildTrustedDataBlockedContentNotice(params: {
  reason?: string;
  /** Display name of the enforcing product; custom app name under full white-labeling. */
  productName?: string;
}): string {
  const productName = params.productName || DEFAULT_APP_NAME;
  const attribution = `Content blocked by ${productName} security guardrails`;
  return `[${attribution}${params.reason ? `: ${params.reason}` : ""}]`;
}

export type ArchestraToolRefusalInfo = {
  toolName?: string;
  toolArguments?: string;
  reason?: string;
};

export function extractTaggedValue(params: {
  input: string;
  tagName: string;
}): string | undefined {
  const { input, tagName } = params;
  if (input.length > MAX_REFUSAL_METADATA_LENGTH) {
    return undefined;
  }

  const openTag = `<${tagName}>`;
  const closeTag = `</${tagName}>`;
  const startIndex = input.indexOf(openTag);
  if (startIndex === -1) {
    return undefined;
  }

  const valueStartIndex = startIndex + openTag.length;
  const endIndex = input.indexOf(closeTag, valueStartIndex);
  if (endIndex === -1) {
    return undefined;
  }

  return input.slice(valueStartIndex, endIndex);
}

export function parseArchestraToolRefusal(
  input: string,
): ArchestraToolRefusalInfo {
  return {
    toolName: extractTaggedValue({
      input,
      tagName: ARCHESTRA_TOOL_NAME_TAG,
    }),
    toolArguments: extractTaggedValue({
      input,
      tagName: ARCHESTRA_TOOL_ARGUMENTS_TAG,
    }),
    reason: extractTaggedValue({
      input,
      tagName: ARCHESTRA_TOOL_REASON_TAG,
    }),
  };
}

export function buildArchestraToolRefusalMetadata(params: {
  toolName: string;
  toolArguments: string;
  reason: string;
}): string {
  const { toolName, toolArguments, reason } = params;
  return [
    `<${ARCHESTRA_TOOL_NAME_TAG}>${toolName}</${ARCHESTRA_TOOL_NAME_TAG}>`,
    `<${ARCHESTRA_TOOL_ARGUMENTS_TAG}>${toolArguments}</${ARCHESTRA_TOOL_ARGUMENTS_TAG}>`,
    `<${ARCHESTRA_TOOL_REASON_TAG}>${reason}</${ARCHESTRA_TOOL_REASON_TAG}>`,
  ].join("\n");
}
