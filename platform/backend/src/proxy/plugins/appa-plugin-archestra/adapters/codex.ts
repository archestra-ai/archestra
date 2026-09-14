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
 * Client adapter for Codex over OpenAI Responses protocol (/v1/responses).
 */
export class AppaCodexAdapter implements AppaClientAdapter {
  readonly id = "codex";
  readonly nativeClient = "codex-responses-v1" as const;
  readonly protocol: AppaProtocol = "responses";

  matches(context: {
    protocol: AppaProtocol;
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): boolean {
    if (context.protocol !== "responses") return false;
    const request = isRecord(context.requestBody) ? context.requestBody : {};
    const metadata = isRecord(request.client_metadata)
      ? request.client_metadata
      : {};
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    const originator = (
      readHeader(context.headers, "originator") ?? ""
    ).toLowerCase();
    return (
      Boolean(readHeader(context.headers, "x-codex-turn-metadata")) ||
      originator.includes("codex") ||
      userAgent.includes("codex") ||
      Object.keys(metadata).some((key) =>
        ["session_id", "thread_id", "x-codex-turn-metadata"].includes(key),
      )
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
    const headerThreadId = readHeader(context.headers, "thread-id");
    const headerMetadata = codexTurnMetadataHeader(
      readHeader(context.headers, "x-codex-turn-metadata"),
    );
    const threadId =
      headerThreadId ??
      (typeof metadata.root_turn_id === "string"
        ? metadata.root_turn_id
        : undefined) ??
      (typeof metadata.session_id === "string"
        ? metadata.session_id
        : undefined) ??
      (typeof metadata.thread_id === "string"
        ? metadata.thread_id
        : undefined) ??
      (typeof headerMetadata.thread_id === "string"
        ? headerMetadata.thread_id
        : undefined) ??
      (context.sessionSource !== "openai_user"
        ? context.sessionId
        : undefined) ??
      undefined;
    const parentSessionId = readHeader(
      context.headers,
      "x-codex-parent-thread-id",
    );
    const spawnBinding = readHeader(
      context.headers,
      "x-archestra-appa-spawn-binding",
    );
    if (!threadId) return {};
    return {
      clientSessionId: threadId,
      threadId,
      ...(parentSessionId ? { parentSessionId, spawnBinding } : {}),
    };
  }

  isNativeSpawnTool(toolName: string): boolean {
    return [
      "multi_agent_v1.spawn_agent",
      "agents.spawn_agent",
      "collaboration.spawn_agent",
    ].includes(toolName);
  }

  nativeControlTarget(toolName: string): string | undefined {
    return [
      "multi_agent_v1.wait_agent",
      "agents.wait_agent",
      "collaboration.wait_agent",
    ].includes(toolName)
      ? `host/codex/${toolName}`
      : undefined;
  }

  unsupportedNativeLifecycleReason(context: {
    headers: Record<string, string | string[] | undefined>;
    requestBody: unknown;
  }): string | null {
    const request = isRecord(context.requestBody) ? context.requestBody : {};
    const metadata = codexTurnMetadata(request);
    return nonEmptyString(metadata.parent_thread_id) ||
      nonEmptyString(metadata.parent_turn_id) ||
      nonEmptyString(metadata.forked_from_thread_id) ||
      metadata.compaction === true ||
      metadata.request_kind === "compaction"
      ? "Codex V1 child, fork, and compaction requests require a durable native lifecycle binding."
      : null;
  }

  extractCarrierChild(): null {
    return null;
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
        const rawName = String(item.name ?? "");
        const namespace = String(item.namespace ?? "");
        const name =
          rawName === "spawn_agent" &&
          ["multi_agent_v1", "agents", "collaboration"].includes(namespace)
            ? `${namespace}.${rawName}`
            : rawName;
        calls.push({
          id: String(item.call_id ?? item.id ?? ""),
          name,
          arguments: args,
          raw: item,
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
    const claimedCalls = new Map<
      string,
      { name: string; rawArguments: string }
    >();
    const results: AppaToolResult[] = [];
    for (const item of records(requestBody.input)) {
      if (
        item.type === "function_call" &&
        nonEmptyString(item.call_id) &&
        nonEmptyString(item.name) &&
        nonEmptyString(item.arguments)
      ) {
        claimedCalls.set(item.call_id, {
          name: qualifiedResponseToolName(item),
          rawArguments: item.arguments,
        });
      }
      if (
        item.type === "function_call_output" &&
        nonEmptyString(item.call_id) &&
        hasReportedResultContent(item, "output")
      ) {
        results.push({
          id: item.call_id,
          content: item.output,
          ...(claimedCalls.has(item.call_id)
            ? { claimedCall: claimedCalls.get(item.call_id) }
            : {}),
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

function qualifiedResponseToolName(item: Record<string, unknown>): string {
  if (typeof item.namespace !== "string" || item.namespace.length === 0) {
    return String(item.name);
  }
  return item.namespace.startsWith("mcp__")
    ? `${item.namespace}__${item.name}`
    : `${item.namespace}.${item.name}`;
}

function codexTurnMetadata(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = isRecord(request.client_metadata)
    ? request.client_metadata
    : {};
  const candidate = metadata["x-codex-turn-metadata"];
  if (typeof candidate === "string") {
    try {
      const parsed = JSON.parse(candidate);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {
    ...(isRecord(candidate) ? candidate : {}),
    ...metadata,
    ...request,
  };
}

function codexTurnMetadataHeader(
  value: string | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
