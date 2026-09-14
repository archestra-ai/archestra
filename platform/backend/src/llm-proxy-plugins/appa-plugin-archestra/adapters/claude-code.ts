import { extractClaudeMetadataSessionId } from "@/routes/proxy/utils/headers/session-id";
import { extractAppaSpawnCarrier } from "@/services/appa-client-correlation";
import type {
  AppaClientAdapter,
  AppaProtocol,
  AppaSessionIdentityResolution,
  AppaToolCall,
  AppaToolResult,
} from "../types";
import {
  hasReportedResultContent,
  isRecord,
  nonEmptyString,
  readHeader,
  records,
} from "../utils";

/**
 * Client adapter for Claude Code over Anthropic Messages protocol (/v1/messages).
 */
export class AppaClaudeCodeAdapter implements AppaClientAdapter {
  readonly id = "claude-code";
  readonly nativeClient = "claude-code" as const;
  readonly protocol: AppaProtocol = "anthropic";
  readonly usesSpawnCarrier = true;

  matches(context: {
    protocol: AppaProtocol;
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): boolean {
    if (context.protocol !== "anthropic") return false;
    const request = isRecord(context.requestBody) ? context.requestBody : {};
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    return (
      userAgent.includes("claude-code") ||
      userAgent.includes("claude_code") ||
      userAgent.includes("claude-cli") ||
      hasClaudeBillingMarker(request.system) ||
      (isRecord(request.metadata) && request.metadata.user_id !== undefined) ||
      readHeader(context.headers, "x-claude-code-session-id") !== undefined
    );
  }

  resolveSessionIdentity(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
    sessionId?: string | null;
    sessionSource?: string | null;
  }): AppaSessionIdentityResolution {
    const request = isRecord(context.requestBody) ? context.requestBody : {};
    const metadataUserId = isRecord(request.metadata)
      ? request.metadata.user_id
      : undefined;
    const headerThreadId = readHeader(context.headers, "thread-id");
    const nativeHeaderSessionId = readHeader(
      context.headers,
      "x-claude-code-session-id",
    );
    const threadId =
      (typeof metadataUserId === "string"
        ? extractClaudeMetadataSessionId(metadataUserId)
        : null) ??
      nativeHeaderSessionId ??
      headerThreadId ??
      context.sessionId ??
      undefined;
    if (!threadId) return {};
    const alias =
      context.sessionSource === "claude_metadata"
        ? undefined
        : context.sessionId;
    if (
      (nativeHeaderSessionId !== undefined &&
        nativeHeaderSessionId !== threadId) ||
      (headerThreadId !== undefined && headerThreadId !== threadId) ||
      (alias !== undefined && alias !== threadId)
    ) {
      return {
        error:
          "OpenAPPA native Claude session metadata conflicts with a native or client session alias.",
      };
    }
    return {
      clientSessionId: threadId,
      threadId,
    };
  }

  isNativeSpawnTool(toolName: string): boolean {
    return toolName === "Agent";
  }

  unsupportedNativeLifecycleReason(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): string | null {
    return extractAppaSpawnCarrier(context.requestBody) &&
      !readHeader(context.headers, "x-claude-code-agent-id")
      ? "Claude Code child requests require a native child locator and signed proxy binding."
      : null;
  }

  extractCarrierChild(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
    sessionId: string | null;
  }): {
    parentClientSessionId: string;
    childClientSessionId: string;
    requestThreadId: string;
  } | null {
    if (!extractAppaSpawnCarrier(context.requestBody)) return null;
    const agentId = readHeader(context.headers, "x-claude-code-agent-id");
    if (!context.sessionId || !agentId) return null;
    return {
      parentClientSessionId: context.sessionId,
      childClientSessionId: `claude:${context.sessionId}:agent:${agentId}`,
      requestThreadId: context.sessionId,
    };
  }

  carrierSpawnTarget(targetName: string): string {
    return targetName === "Agent" ? "agent/claude-code/Agent" : targetName;
  }

  canonicalizeLocalToolName(rawName: string): string {
    if (
      rawName.startsWith("mcp/") ||
      rawName.startsWith("mcp__") ||
      rawName.startsWith("host/")
    ) {
      return rawName;
    }
    return `host/claude-code/${rawName}`;
  }

  extractToolCalls(responseBody: unknown): AppaToolCall[] {
    if (!isRecord(responseBody) || !Array.isArray(responseBody.content)) {
      return [];
    }
    const calls: AppaToolCall[] = [];
    for (const block of responseBody.content) {
      if (isRecord(block) && block.type === "tool_use") {
        const name = String(block.name ?? "");
        calls.push({
          id: String(block.id ?? ""),
          name,
          arguments: isRecord(block.input) ? block.input : {},
          raw: block,
          spawn: this.isNativeSpawnTool(name),
        });
      }
    }
    return calls;
  }

  rewriteToolCalls(
    responseBody: unknown,
    authorizedCalls: AppaToolCall[],
  ): unknown {
    if (!isRecord(responseBody) || !Array.isArray(responseBody.content)) {
      return responseBody;
    }
    const authorizedMap = new Map(authorizedCalls.map((c) => [c.id, c]));
    const content = responseBody.content.map((block) => {
      if (isRecord(block) && block.type === "tool_use") {
        const authorized = authorizedMap.get(String(block.id));
        if (authorized) {
          return {
            ...block,
            name: authorized.name,
            input: authorized.arguments,
          };
        }
      }
      return block;
    });
    return { ...responseBody, content };
  }

  extractToolResults(requestBody: unknown): AppaToolResult[] {
    if (!isRecord(requestBody) || !Array.isArray(requestBody.messages)) {
      return [];
    }
    const claimedCalls = new Map<
      string,
      { name: string; rawArguments: string }
    >();
    for (const message of records(requestBody.messages)) {
      for (const block of records(message.content)) {
        if (
          message.role === "assistant" &&
          block.type === "tool_use" &&
          nonEmptyString(block.id) &&
          nonEmptyString(block.name) &&
          isRecord(block.input)
        ) {
          claimedCalls.set(block.id, {
            name: block.name,
            rawArguments: JSON.stringify(block.input),
          });
        }
      }
    }
    const results: AppaToolResult[] = [];
    for (const message of records(requestBody.messages)) {
      if (message.role !== "user") continue;
      for (const block of records(message.content)) {
        if (
          block.type !== "tool_result" ||
          !nonEmptyString(block.tool_use_id) ||
          !hasReportedResultContent(block, "content")
        ) {
          continue;
        }
        results.push({
          id: block.tool_use_id,
          content: block.content,
          isError: Boolean(block.is_error),
          ...(block.is_error === true
            ? {
                status: "failure" as const,
                message: "Native client reported a tool error.",
              }
            : {}),
          ...(claimedCalls.has(block.tool_use_id)
            ? { claimedCall: claimedCalls.get(block.tool_use_id) }
            : {}),
        });
      }
    }
    return results;
  }

  formatToolResult(admittedResult: AppaToolResult): unknown {
    return {
      type: "tool_result",
      tool_use_id: admittedResult.id,
      content: admittedResult.content,
      is_error: admittedResult.isError ?? false,
    };
  }
}

function hasClaudeBillingMarker(value: unknown): boolean {
  const text = Array.isArray(value)
    ? value
        .map((block) =>
          isRecord(block) && typeof block.text === "string" ? block.text : "",
        )
        .join("\n")
    : typeof value === "string"
      ? value
      : "";
  return (
    /x-anthropic-billing-header/i.test(text) && /cc_entrypoint=\S+/i.test(text)
  );
}
