import type {
  AppaClientAdapter,
  AppaProtocol,
  AppaSessionIdentity,
  AppaToolCall,
  AppaToolResult,
} from "../types";

/**
 * Client adapter for Claude Code over Anthropic Messages protocol (/v1/messages).
 */
export class AppaClaudeCodeAdapter implements AppaClientAdapter {
  readonly id = "claude-code";
  readonly protocol: AppaProtocol = "anthropic";

  matches(context: {
    protocol: AppaProtocol;
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): boolean {
    if (context.protocol !== "anthropic") return false;
    const userAgent = String(
      context.headers["user-agent"] ?? context.headers["User-Agent"] ?? "",
    ).toLowerCase();
    const clientApp = String(
      context.headers["x-client-app"] ?? "",
    ).toLowerCase();
    return (
      userAgent.includes("claude-code") ||
      clientApp.includes("claude-code") ||
      Boolean(context.headers["anthropic-version"])
    );
  }

  extractSessionIdentity(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): AppaSessionIdentity {
    const threadId =
      readHeader(context.headers, "x-session-id") ??
      readHeader(context.headers, "x-anthropic-session-id");
    const spawnBinding = readHeader(context.headers, "x-appa-spawn-binding");
    return {
      clientSessionId: threadId,
      threadId,
      spawnBinding,
    };
  }

  extractToolCalls(responseBody: unknown): AppaToolCall[] {
    if (!isRecord(responseBody) || !Array.isArray(responseBody.content)) {
      return [];
    }
    const calls: AppaToolCall[] = [];
    for (const block of responseBody.content) {
      if (isRecord(block) && block.type === "tool_use") {
        calls.push({
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          arguments: isRecord(block.input) ? block.input : {},
          raw: block,
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
    const results: AppaToolResult[] = [];
    for (const message of requestBody.messages) {
      if (isRecord(message) && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (isRecord(block) && block.type === "tool_result") {
            results.push({
              id: String(block.tool_use_id ?? ""),
              content: block.content,
              isError: Boolean(block.is_error),
            });
          }
        }
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

function readHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
