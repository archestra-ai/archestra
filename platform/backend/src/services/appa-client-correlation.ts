import AppaNativeChildCorrelationModel from "@/models/appa-native-child-correlation";
import type { AppaInboundToolResult } from "@/routes/proxy/appa-proxy-hook";
import { AppaProxyLedger } from "@/services/appa-proxy/ledger";

type AppaCarrierChildClaim = {
  parentClientSessionId: string;
  childClientSessionId: string;
  requestThreadId: string;
};

/**
 * Resolves a child solely from a proxy-issued carrier carried in the first user
 * prompt. Client headers establish locators, never authority; the parent call,
 * owner scope, canonical arguments, and runtime binding are rechecked here.
 */
export async function resolveAppaCarrierChild(params: {
  child: AppaCarrierChildClaim | null;
  request: unknown;
  ownerScopeHash: string;
  profileId: string;
}): Promise<{
  parentClientSessionId: string;
  childClientSessionId: string;
  requestThreadId: string;
  spawnBinding: string;
} | null> {
  const child = params.child;
  if (!child) return null;
  const carrier = extractAppaSpawnCarrier(params.request);
  if (!carrier) return null;
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
    callId: carrier.callId,
    carrier: carrier.carrier,
  });
  return { ...child, spawnBinding };
}

/** Extracts the one proxy-issued carrier from ordinary user prompt positions. */
export function extractAppaSpawnCarrier(
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
        if (
          block.type !== "tool_result" ||
          !text(block.tool_use_id) ||
          !hasReportedResultContent(block, "content")
        ) {
          continue;
        }
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
      if (
        message.role === "tool" &&
        text(message.tool_call_id) &&
        hasReportedResultContent(message, "content")
      ) {
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
      if (
        item.type === "function_call_output" &&
        text(item.call_id) &&
        hasReportedResultContent(item, "output")
      ) {
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

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

/** A local observation is valid only when the stock wire carries a result body. */
function hasReportedResultContent(
  value: Record<string, unknown>,
  field: "content" | "output",
): boolean {
  return Object.hasOwn(value, field) && value[field] !== null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
