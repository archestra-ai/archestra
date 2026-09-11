import AppaNativeChildCorrelationModel from "@/models/appa-native-child-correlation";
import type { AppaInboundToolResult } from "@/routes/proxy/appa-proxy-hook";
import { AppaProxyLedger } from "@/services/appa-proxy/ledger";

export type AppaNativeClient =
  | "claude-code"
  | "codex-responses-v1"
  | "opencode-kimi"
  | "unknown";

/**
 * Classifies protocol evidence only. The result is deliberately never an
 * identity or authorization input: APPA owner scope comes from credentials.
 */
export function classifyAppaNativeClient(params: {
  provider: string;
  interactionType: string;
  headers: Record<string, string | string[] | undefined>;
  request: unknown;
}): AppaNativeClient {
  const headers = normalizedHeaders(params.headers);
  const request = object(params.request);
  const userAgent = header(headers, "user-agent")?.toLowerCase() ?? "";
  const originator = header(headers, "originator")?.toLowerCase() ?? "";

  if (
    params.interactionType === "anthropic:messages" &&
    (userAgent.includes("claude-code") ||
      hasClaudeBillingMarker(request.system) ||
      object(request.metadata).user_id !== undefined ||
      header(headers, "x-claude-code-session-id") !== undefined)
  ) {
    return "claude-code";
  }

  if (
    params.interactionType === "openai:responses" &&
    (originator.includes("codex") ||
      userAgent.includes("codex") ||
      Object.keys(object(request.client_metadata)).some((key) =>
        ["session_id", "thread_id", "x-codex-turn-metadata"].includes(key),
      ))
  ) {
    return "codex-responses-v1";
  }

  if (
    params.provider === "kimi" &&
    params.interactionType === "kimi:chatCompletions" &&
    (originator.includes("opencode") ||
      userAgent.includes("opencode") ||
      header(headers, "x-opencode-session") !== undefined)
  ) {
    return "opencode-kimi";
  }

  return "unknown";
}

/**
 * Native child/fork assertions cannot become a new APPA root. Codex code-mode
 * has a separate durable signed-spawn implementation; other lifecycle shapes
 * stay rejected until they have equivalent provider-wire proof.
 */
export function unsupportedNativeLifecycleReason(params: {
  client: AppaNativeClient;
  headers: Record<string, string | string[] | undefined>;
  request: unknown;
}): string | null {
  const headers = normalizedHeaders(params.headers);
  const request = object(params.request);
  if (
    params.client === "claude-code" &&
    spawnCarrierFromRequest(params.request) &&
    !header(headers, "x-claude-code-agent-id")
  ) {
    return "Claude Code child requests require a native child locator and signed proxy binding.";
  }
  if (
    params.client === "opencode-kimi" &&
    header(headers, "x-parent-session-id")
  ) {
    return "OpenCode child requests require a signed native child binding.";
  }
  if (params.client === "codex-responses-v1") {
    const metadata = codexTurnMetadata(request);
    if (
      text(metadata.parent_thread_id) ||
      text(metadata.parent_turn_id) ||
      text(metadata.forked_from_thread_id) ||
      metadata.compaction === true ||
      metadata.request_kind === "compaction"
    ) {
      return "Codex V1 child, fork, and compaction requests require a durable native lifecycle binding.";
    }
  }
  return null;
}

/**
 * Resolves a child solely from a proxy-issued carrier carried in the first user
 * prompt. Client headers establish locators, never authority; the parent call,
 * owner scope, canonical arguments, and runtime binding are rechecked here.
 */
export async function resolveAppaCarrierChild(params: {
  client: AppaNativeClient;
  headers: Record<string, string | string[] | undefined>;
  request: unknown;
  sessionId: string | null;
  ownerScopeHash: string;
  profileId: string;
}): Promise<{
  parentClientSessionId: string;
  childClientSessionId: string;
  spawnBinding: string;
} | null> {
  const child = childCarrierRequest(params);
  if (!child) return null;
  const parent = await AppaNativeChildCorrelationModel.findOwnedParentByClient({
    ownerScopeHash: params.ownerScopeHash,
    profileId: params.profileId,
    parentClientSessionId: child.parentClientSessionId,
  });
  const spawnBinding = await new AppaProxyLedger({
    sessionId: parent.id,
    ownerScopeHash: params.ownerScopeHash,
    profileId: params.profileId,
  }).resolveChildCarrier({
    parentClientSessionId: child.parentClientSessionId,
    callId: child.callId,
    carrier: child.carrier,
  });
  return { ...child, spawnBinding };
}

/**
 * Extracts only documented tool-result positions. Client names/arguments are
 * retained solely as contradiction checks; the durable APPA call ledger remains
 * the authority for the executable call.
 */
export function collectAppaProtocolToolResults(params: {
  request: unknown;
  interactionType: string;
}): AppaInboundToolResult[] {
  const request = object(params.request);
  if (params.interactionType === "anthropic:messages") {
    const claimedCalls = new Map<
      string,
      { name: string; rawArguments: string }
    >();
    const results: AppaInboundToolResult[] = [];
    for (const message of objects(request.messages)) {
      for (const block of objects(message.content)) {
        if (
          message.role === "assistant" &&
          block.type === "tool_use" &&
          text(block.id) &&
          text(block.name) &&
          isObject(block.input)
        ) {
          claimedCalls.set(block.id, {
            name: block.name,
            rawArguments: JSON.stringify(block.input),
          });
        }
      }
    }
    for (const message of objects(request.messages)) {
      if (message.role !== "user") continue;
      for (const block of objects(message.content)) {
        if (block.type !== "tool_result" || !text(block.tool_use_id)) continue;
        results.push({
          id: block.tool_use_id,
          content: block.content,
          ...(block.is_error === true
            ? {
                status: "failure" as const,
                message: "Native client reported a tool error.",
              }
            : {}),
          claimedCall: claimedCalls.get(block.tool_use_id),
        });
      }
    }
    return results;
  }

  if (
    params.interactionType === "openai:chatCompletions" ||
    params.interactionType === "kimi:chatCompletions"
  ) {
    const claimedCalls = new Map<
      string,
      { name: string; rawArguments: string }
    >();
    const results: AppaInboundToolResult[] = [];
    for (const message of objects(request.messages)) {
      for (const call of objects(message.tool_calls)) {
        const fn = object(call.function);
        if (text(call.id) && text(fn.name) && text(fn.arguments)) {
          claimedCalls.set(call.id, {
            name: fn.name,
            rawArguments: fn.arguments,
          });
        }
      }
      if (message.role === "tool" && text(message.tool_call_id)) {
        results.push({
          id: message.tool_call_id,
          content: message.content,
          claimedCall: claimedCalls.get(message.tool_call_id),
        });
      }
    }
    return results;
  }

  if (params.interactionType === "openai:responses") {
    const claimedCalls = new Map<
      string,
      { name: string; rawArguments: string }
    >();
    const results: AppaInboundToolResult[] = [];
    for (const item of objects(request.input)) {
      if (
        item.type === "function_call" &&
        text(item.call_id) &&
        text(item.name) &&
        text(item.arguments)
      ) {
        claimedCalls.set(item.call_id, {
          name: qualifiedResponseToolName(item),
          rawArguments: item.arguments,
        });
      }
      if (item.type === "function_call_output" && text(item.call_id)) {
        results.push({
          id: item.call_id,
          content: item.output,
          claimedCall: claimedCalls.get(item.call_id),
        });
      }
    }
    return results;
  }

  return [];
}

function qualifiedResponseToolName(item: Record<string, unknown>): string {
  if (typeof item.namespace !== "string" || item.namespace.length === 0) {
    return String(item.name);
  }
  // Codex returns MCP calls as a namespace/member pair, but APPA bound the
  // outbound wire using the global MCP spelling (`mcp__server__tool`).
  return item.namespace.startsWith("mcp__")
    ? `${item.namespace}__${item.name}`
    : `${item.namespace}.${item.name}`;
}

function childCarrierRequest(params: {
  client: AppaNativeClient;
  headers: Record<string, string | string[] | undefined>;
  request: unknown;
  sessionId: string | null;
}): {
  parentClientSessionId: string;
  childClientSessionId: string;
  callId: string;
  carrier: string;
} | null {
  const marker = spawnCarrierFromRequest(params.request);
  if (!marker) return null;
  const headers = normalizedHeaders(params.headers);
  if (params.client === "claude-code") {
    const agentId = header(headers, "x-claude-code-agent-id");
    if (!params.sessionId || !agentId) return null;
    return {
      parentClientSessionId: params.sessionId,
      childClientSessionId: `claude:${params.sessionId}:agent:${agentId}`,
      ...marker,
    };
  }
  if (params.client === "opencode-kimi") {
    const parentClientSessionId = header(headers, "x-parent-session-id");
    if (!params.sessionId || !parentClientSessionId) return null;
    return {
      parentClientSessionId,
      childClientSessionId: params.sessionId,
      ...marker,
    };
  }
  return null;
}

function spawnCarrierFromRequest(
  request: unknown,
): { callId: string; carrier: string } | null {
  const marker = /\b(apc1\.([^.\s]+)\.[a-f0-9]{64}\.[a-f0-9]{64})\b/g;
  const matches = collectUserText(request)
    .flatMap((text) =>
      [...text.matchAll(marker)].map((match) => match.slice(1)),
    )
    .filter((match): match is [string, string] => match.length === 2);
  if (matches.length !== 1) return null;
  const [carrier, callId] = matches[0];
  return { callId, carrier };
}

function collectUserText(request: unknown): string[] {
  const value = object(request);
  const messages = objects(value.messages);
  const chatText = messages.flatMap((message) =>
    message.role === "user" ? contentText(message.content) : [],
  );
  const responsesText = objects(value.input).flatMap((item) =>
    item.type === "message" && item.role === "user"
      ? contentText(item.content)
      : [],
  );
  return [...chatText, ...responsesText];
}

function contentText(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return objects(value).flatMap((part) =>
    typeof part.text === "string" &&
    (part.type === "text" || part.type === "input_text")
      ? [part.text]
      : [],
  );
}

function normalizedHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      typeof value === "string" ? value : undefined,
    ]),
  );
}

function header(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return value?.trim() || undefined;
}

function hasClaudeBillingMarker(value: unknown): boolean {
  const text = Array.isArray(value)
    ? value
        .map((block) =>
          isObject(block) && typeof block.text === "string" ? block.text : "",
        )
        .join("\n")
    : typeof value === "string"
      ? value
      : "";
  return (
    /x-anthropic-billing-header/i.test(text) && /cc_entrypoint=\S+/i.test(text)
  );
}

function codexTurnMetadata(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = object(request.client_metadata);
  const candidate = metadata["x-codex-turn-metadata"];
  if (typeof candidate === "string") {
    try {
      return object(JSON.parse(candidate));
    } catch {
      return {};
    }
  }
  return {
    ...object(candidate),
    ...metadata,
    ...request,
  };
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
