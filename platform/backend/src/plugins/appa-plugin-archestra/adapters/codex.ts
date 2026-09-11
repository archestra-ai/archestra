import {
  type AppaClientAdapter,
  type AppaProtocol,
  type AppaSessionIdentity,
  type AppaToolCall,
  type AppaToolResult,
  isAppaSpawnTool,
} from "../types";

/**
 * Client adapter for Codex over OpenAI Responses protocol (/v1/responses).
 */
export class AppaCodexAdapter implements AppaClientAdapter {
  readonly id = "codex";
  readonly protocol: AppaProtocol = "responses";

  matches(context: {
    protocol: AppaProtocol;
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): boolean {
    if (context.protocol !== "responses") return false;
    const turnMetadata = readHeader(context.headers, "x-codex-turn-metadata");
    const userAgent = String(
      context.headers["user-agent"] ?? context.headers["User-Agent"] ?? "",
    ).toLowerCase();
    const clientApp = String(
      context.headers["x-client-app"] ?? "",
    ).toLowerCase();
    return (
      Boolean(turnMetadata) ||
      userAgent.includes("codex") ||
      clientApp.includes("codex")
    );
  }

  extractSessionIdentity(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): AppaSessionIdentity {
    const rawMetadata = readHeader(context.headers, "x-codex-turn-metadata");
    let threadId: string | undefined;
    if (rawMetadata) {
      try {
        const parsed = JSON.parse(rawMetadata) as Record<string, unknown>;
        if (typeof parsed.thread_id === "string") threadId = parsed.thread_id;
      } catch {
        // ignore JSON parse failure
      }
    }
    const clientSessionId =
      threadId ?? readHeader(context.headers, "x-session-id");
    const spawnBinding = readHeader(context.headers, "x-appa-spawn-binding");
    return {
      clientSessionId,
      threadId: clientSessionId,
      spawnBinding,
    };
  }

  canonicalizeLocalToolName(rawName: string): string {
    const stripped = rawName.startsWith("functions.")
      ? rawName.slice("functions.".length)
      : rawName;
    if (
      stripped.startsWith("mcp:") ||
      stripped.startsWith("builtin:") ||
      stripped.startsWith("host/")
    ) {
      return stripped;
    }
    return `builtin:${stripped}`;
  }

  extractToolCalls(responseBody: unknown): AppaToolCall[] {
    if (!isRecord(responseBody) || !Array.isArray(responseBody.output)) {
      return [];
    }
    const calls: AppaToolCall[] = [];
    for (const item of responseBody.output) {
      if (isRecord(item) && item.type === "function_call") {
        let args: Record<string, unknown> = {};
        if (typeof item.arguments === "string") {
          try {
            args = JSON.parse(item.arguments) as Record<string, unknown>;
          } catch {
            // keep empty
          }
        } else if (isRecord(item.arguments)) {
          args = item.arguments;
        }
        const name = String(item.name ?? "");
        calls.push({
          id: String(item.call_id ?? item.id ?? ""),
          name,
          arguments: args,
          raw: item,
          spawn: isAppaSpawnTool(name),
        });
      }
    }
    return calls;
  }

  rewriteToolCalls(
    responseBody: unknown,
    authorizedCalls: AppaToolCall[],
  ): unknown {
    if (!isRecord(responseBody) || !Array.isArray(responseBody.output)) {
      return responseBody;
    }
    const authorizedMap = new Map(authorizedCalls.map((c) => [c.id, c]));
    const output = responseBody.output.map((item) => {
      if (isRecord(item) && item.type === "function_call") {
        const callId = String(item.call_id ?? item.id ?? "");
        const authorized = authorizedMap.get(callId);
        if (authorized) {
          return {
            ...item,
            name: authorized.name,
            arguments: JSON.stringify(authorized.arguments),
          };
        }
      }
      return item;
    });
    return { ...responseBody, output };
  }

  extractToolResults(requestBody: unknown): AppaToolResult[] {
    if (!isRecord(requestBody) || !Array.isArray(requestBody.input)) {
      return [];
    }
    const results: AppaToolResult[] = [];
    for (const item of requestBody.input) {
      if (isRecord(item) && item.type === "function_call_output") {
        results.push({
          id: String(item.call_id ?? ""),
          content: item.output,
        });
      }
    }
    return results;
  }

  formatToolResult(admittedResult: AppaToolResult): unknown {
    return {
      type: "function_call_output",
      call_id: admittedResult.id,
      output:
        typeof admittedResult.content === "string"
          ? admittedResult.content
          : JSON.stringify(admittedResult.content),
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
