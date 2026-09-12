import {
  type AppaClientAdapter,
  type AppaProtocol,
  type AppaSessionIdentity,
  type AppaToolCall,
  type AppaToolResult,
  isAppaSpawnTool,
} from "../types";
import { isRecord, readHeader } from "../utils";

/**
 * Client adapter for OpenCode over OpenAI Chat Completions protocol (/v1/chat/completions).
 */
export class AppaOpenCodeAdapter implements AppaClientAdapter {
  readonly id = "opencode";
  readonly protocol: AppaProtocol = "chat_completions";

  matches(context: {
    protocol: AppaProtocol;
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): boolean {
    if (context.protocol !== "chat_completions") return false;
    const sessionAffinity = readHeader(context.headers, "x-session-affinity");
    const userAgent = String(
      context.headers["user-agent"] ?? context.headers["User-Agent"] ?? "",
    ).toLowerCase();
    const clientApp = String(
      context.headers["x-client-app"] ?? "",
    ).toLowerCase();
    return (
      Boolean(sessionAffinity) ||
      userAgent.includes("opencode") ||
      clientApp.includes("opencode")
    );
  }

  extractSessionIdentity(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): AppaSessionIdentity {
    const affinity = readHeader(context.headers, "x-session-affinity");
    const sessionId = affinity ?? readHeader(context.headers, "x-session-id");
    const parentSessionId = readHeader(context.headers, "x-parent-session-id");
    const spawnBinding = readHeader(context.headers, "x-appa-spawn-binding");
    return {
      clientSessionId: sessionId,
      parentSessionId,
      threadId: sessionId,
      spawnBinding,
    };
  }

  canonicalizeLocalToolName(rawName: string): string {
    if (
      rawName.startsWith("mcp:") ||
      rawName.startsWith("builtin:") ||
      rawName.startsWith("host/")
    ) {
      return rawName;
    }
    return `builtin:${rawName}`;
  }

  extractToolCalls(responseBody: unknown): AppaToolCall[] {
    if (!isRecord(responseBody) || !Array.isArray(responseBody.choices)) {
      return [];
    }
    const calls: AppaToolCall[] = [];
    for (const choice of responseBody.choices) {
      if (isRecord(choice) && isRecord(choice.message)) {
        const message = choice.message;
        if (Array.isArray(message.tool_calls)) {
          for (const tc of message.tool_calls) {
            if (isRecord(tc) && isRecord(tc.function)) {
              let args: Record<string, unknown> = {};
              if (typeof tc.function.arguments === "string") {
                try {
                  args = JSON.parse(tc.function.arguments) as Record<
                    string,
                    unknown
                  >;
                } catch {
                  // ignore
                }
              } else if (isRecord(tc.function.arguments)) {
                args = tc.function.arguments;
              }
              const name = String(tc.function.name ?? "");
              calls.push({
                id: String(tc.id ?? ""),
                name,
                arguments: args,
                raw: tc,
                spawn: isAppaSpawnTool(name),
              });
            }
          }
        }
      }
    }
    return calls;
  }

  rewriteToolCalls(
    responseBody: unknown,
    authorizedCalls: AppaToolCall[],
  ): unknown {
    if (!isRecord(responseBody) || !Array.isArray(responseBody.choices)) {
      return responseBody;
    }
    const authorizedMap = new Map(authorizedCalls.map((c) => [c.id, c]));
    const choices = responseBody.choices.map((choice) => {
      if (
        isRecord(choice) &&
        isRecord(choice.message) &&
        Array.isArray(choice.message.tool_calls)
      ) {
        const toolCalls = choice.message.tool_calls.map((tc) => {
          if (isRecord(tc) && isRecord(tc.function)) {
            const authorized = authorizedMap.get(String(tc.id));
            if (authorized) {
              return {
                ...tc,
                function: {
                  ...tc.function,
                  name: authorized.name,
                  arguments: JSON.stringify(authorized.arguments),
                },
              };
            }
          }
          return tc;
        });
        return {
          ...choice,
          message: {
            ...choice.message,
            tool_calls: toolCalls,
          },
        };
      }
      return choice;
    });
    return { ...responseBody, choices };
  }

  extractToolResults(requestBody: unknown): AppaToolResult[] {
    if (!isRecord(requestBody) || !Array.isArray(requestBody.messages)) {
      return [];
    }
    const results: AppaToolResult[] = [];
    for (const message of requestBody.messages) {
      if (isRecord(message) && message.role === "tool") {
        results.push({
          id: String(message.tool_call_id ?? ""),
          content: message.content,
        });
      }
    }
    return results;
  }

  formatToolResult(admittedResult: AppaToolResult): unknown {
    return {
      role: "tool",
      tool_call_id: admittedResult.id,
      content:
        typeof admittedResult.content === "string"
          ? admittedResult.content
          : JSON.stringify(admittedResult.content),
    };
  }
}
