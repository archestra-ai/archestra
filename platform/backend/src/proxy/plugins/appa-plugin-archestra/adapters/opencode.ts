import { extractAppaSpawnCarrier } from "@/services/appa-client-correlation";
import type {
  AppaClientAdapter,
  AppaProtocol,
  AppaSessionIdentity,
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
 * Client adapter for OpenCode over OpenAI Chat Completions protocol (/v1/chat/completions).
 */
export class AppaOpenCodeAdapter implements AppaClientAdapter {
  readonly id = "opencode";
  readonly nativeClient = "opencode-kimi" as const;
  readonly protocol: AppaProtocol = "chat_completions";
  readonly usesSpawnCarrier = true;

  matches(context: {
    protocol: AppaProtocol;
    provider?: string;
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): boolean {
    if (
      context.protocol !== "chat_completions" ||
      (context.provider !== undefined &&
        context.provider !== "kimi" &&
        context.provider !== "openai")
    ) {
      return false;
    }
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    const originator = (
      readHeader(context.headers, "originator") ?? ""
    ).toLowerCase();
    return (
      Boolean(readHeader(context.headers, "x-opencode-session")) ||
      userAgent.includes("opencode") ||
      originator.includes("opencode")
    );
  }

  resolveSessionIdentity(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
    sessionId?: string | null;
    sessionSource?: string | null;
  }): AppaSessionIdentity {
    const request = isRecord(context.requestBody) ? context.requestBody : {};
    const metadata = isRecord(request.client_metadata)
      ? request.client_metadata
      : {};
    const threadId =
      readHeader(context.headers, "thread-id") ??
      readHeader(context.headers, "x-opencode-session") ??
      (typeof metadata.root_turn_id === "string"
        ? metadata.root_turn_id
        : undefined) ??
      (typeof metadata.session_id === "string"
        ? metadata.session_id
        : undefined) ??
      (typeof metadata.thread_id === "string"
        ? metadata.thread_id
        : undefined) ??
      (context.sessionSource !== "openai_user"
        ? context.sessionId
        : undefined) ??
      undefined;
    if (!threadId) return {};
    const parentSessionId = readHeader(context.headers, "x-parent-session-id");
    return {
      clientSessionId: threadId,
      threadId,
      ...(parentSessionId ? { parentSessionId } : {}),
    };
  }

  isNativeSpawnTool(toolName: string): boolean {
    return toolName === "task";
  }

  unsupportedNativeLifecycleReason(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): string | null {
    return readHeader(context.headers, "x-parent-session-id")
      ? "OpenCode child requests require a signed native child binding."
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
    const parentClientSessionId = readHeader(
      context.headers,
      "x-parent-session-id",
    );
    if (!context.sessionId || !parentClientSessionId) return null;
    return {
      parentClientSessionId,
      childClientSessionId: context.sessionId,
      requestThreadId: context.sessionId,
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
                spawn: this.isNativeSpawnTool(name),
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
    const claimedCalls = new Map<
      string,
      { name: string; rawArguments: string }
    >();
    const results: AppaToolResult[] = [];
    for (const message of records(requestBody.messages)) {
      for (const call of records(message.tool_calls)) {
        const fn = isRecord(call.function) ? call.function : {};
        if (
          nonEmptyString(call.id) &&
          nonEmptyString(fn.name) &&
          nonEmptyString(fn.arguments)
        ) {
          claimedCalls.set(call.id, {
            name: fn.name,
            rawArguments: fn.arguments,
          });
        }
      }
      if (
        message.role === "tool" &&
        nonEmptyString(message.tool_call_id) &&
        hasReportedResultContent(message, "content")
      ) {
        results.push({
          id: message.tool_call_id,
          content: message.content,
          ...(claimedCalls.has(message.tool_call_id)
            ? { claimedCall: claimedCalls.get(message.tool_call_id) }
            : {}),
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
