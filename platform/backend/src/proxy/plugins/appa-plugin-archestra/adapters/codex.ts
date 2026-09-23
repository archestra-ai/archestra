import type { IncomingHttpHeaders } from "node:http";
import {
  codexClientMetadataSessionId,
  isCodexClientMetadata,
} from "@archestra/shared";
import type { AppaSessionIdentity } from "@/openappa/wire";
import { ApiError } from "@/types";
import type { CommonToolResult } from "@/types/common-llm-format";
import type {
  AppaClientAdapter,
  AppaMatchContext,
  AppaSpawnPromptField,
  AskUserArguments,
} from "../types";
import { questionHeader, readHeader } from "../utils";
import { structuredQuestionRuling } from "./native-question-ruling";
import {
  asRecord,
  bindMintedChildTrajectory,
  localToolName,
  namesChildrenFromArguments,
  parseJsonHeader,
  stringField,
  stripRecordFields,
} from "./trajectory";

const SPAWN_TOOLS = new Set(["spawn_agent"]);
const CHILD_ID_KEYS = ["agent_id", "thread_id", "receiver_thread_id"] as const;

/** Identifies Codex Responses requests and normalizes local tool names. */
export class AppaCodexAdapter implements AppaClientAdapter {
  readonly id = "codex" as const;
  readonly trajectoryPrefix = "codex";
  // Codex advertises request_user_input even when Default mode cannot run it.
  // Keep ask_user on the gateway so Codex shows an MCP elicitation form.
  readonly nativeQuestion = {
    toolName: "request_user_input",
    supportsMultiple: false,
    isAvailable: (headers: IncomingHttpHeaders) =>
      readHeader(headers, "x-archestra-native-question") ===
      "request_user_input",
    fromAskUser: (args: AskUserArguments) => ({
      questions: [
        {
          id: "archestra_question",
          header: questionHeader(args.header, 12),
          question: args.question,
          options: args.options.map((option) => ({
            label: option.label,
            description: option.description ?? option.label,
          })),
        },
      ],
    }),
    rulingFromResult: structuredQuestionRuling,
  };
  matches(context: AppaMatchContext): boolean {
    const userAgent = (
      readHeader(context.headers, "user-agent") ?? ""
    ).toLowerCase();
    const originator = (
      readHeader(context.headers, "originator") ?? ""
    ).toLowerCase();
    return (
      userAgent.includes("codex") ||
      originator.includes("codex") ||
      readHeader(context.headers, "x-codex-turn-metadata") !== undefined ||
      isCodexClientMetadata(asRecord(context.requestBody)?.client_metadata)
    );
  }

  classifyToolName(name: string, namespace?: string): "gateway" | "local" {
    // Codex declares MCP server tools in `mcp__<server>` namespaces
    // and invokes them using bare advertised names.
    return name.startsWith("mcp:") ||
      name.startsWith("mcp__") ||
      namespace?.startsWith("mcp__")
      ? "gateway"
      : "local";
  }

  normalizeLocalToolName(name: string): string {
    // The Archestra adapter derives bare tool names to host/archestra identity.
    // Removes `functions.` and `builtin:` client prefixes before derivation.
    const stripped = name.startsWith("functions.")
      ? name.slice("functions.".length)
      : name;
    return stripped.startsWith("builtin:")
      ? stripped.slice("builtin:".length)
      : stripped;
  }

  /**
   * Extracts Codex trajectory identity from turn metadata across body and header fields.
   * Uses `thread_id` as the primary root: resumes reopen the thread, forks mint
   * a new thread, and compactions stay within the same thread.
   * Contradictory claims are rejected.
   */
  extractSessionIdentity(
    context: AppaMatchContext,
  ): AppaSessionIdentity | undefined {
    const claims: Array<{ sessionId?: string; threadId?: string } | undefined> =
      [];
    const clientMetadata = asRecord(context.requestBody)?.client_metadata;
    if (clientMetadata !== undefined) {
      const flat = asRecord(clientMetadata);
      if (flat) claims.push(idClaims(flat, "client_metadata"));
      claims.push(
        turnMetadataClaims(asRecord(clientMetadata)?.["x-codex-turn-metadata"]),
      );
    }
    claims.push(
      turnMetadataClaims(readHeader(context.headers, "x-codex-turn-metadata")),
    );
    const headerSessionId = readHeader(context.headers, "session-id")?.trim();
    if (headerSessionId) claims.push({ sessionId: headerSessionId });

    let sessionId: string | undefined;
    let threadId: string | undefined;
    for (const claim of claims) {
      if (!claim) continue;
      if (
        (claim.sessionId && sessionId && claim.sessionId !== sessionId) ||
        (claim.threadId && threadId && claim.threadId !== threadId)
      ) {
        throw new ApiError(
          400,
          "OpenAPPA cannot bind contradictory Codex trajectory metadata",
        );
      }
      sessionId ??= claim.sessionId;
      threadId ??= claim.threadId;
    }
    // `forked_from_thread_id` marks a client fork.
    // The runtime only opens a child trajectory for a prepared spawn call.
    // Replayed history carries parent trajectory stamps that continue the parent root.
    const root = threadId ?? sessionId;
    return root
      ? { sessionId: root, provenance: "codex-turn-metadata" }
      : undefined;
  }

  isSpawnTool(name: string, namespace?: string): boolean {
    return (
      isNativeCodexNamespace(namespace) && SPAWN_TOOLS.has(localToolName(name))
    );
  }

  classifySpawnResult(
    result: CommonToolResult,
  ): "pending" | "failed" | undefined {
    if (!this.isSpawnTool(result.name, result.namespace)) return undefined;
    if (result.isError) return "failed";
    const output =
      typeof result.content === "string"
        ? parseJsonObject(result.content)
        : asRecord(result.content);
    return stringField(output?.agent_id) || stringField(output?.task_name)
      ? "pending"
      : "failed";
  }

  isChildCompletionResult(result: CommonToolResult): boolean {
    if (
      !isNativeCodexNamespace(result.namespace) ||
      localToolName(result.name) !== "wait_agent" ||
      result.isError
    )
      return false;
    const output =
      typeof result.content === "string"
        ? parseJsonObject(result.content)
        : asRecord(result.content);
    const status = asRecord(output?.status);
    return Object.values(status ?? {}).some(
      (entry) => typeof asRecord(entry)?.completed === "string",
    );
  }

  normalizeChildLaunchResult(result: CommonToolResult): string | undefined {
    if (
      !this.isSpawnTool(result.name, result.namespace) ||
      this.classifySpawnResult(result) === "failed"
    )
      return undefined;
    const output =
      typeof result.content === "string"
        ? parseJsonObject(result.content)
        : asRecord(result.content);
    const id = stringField(output?.agent_id) ?? stringField(output?.task_name);
    if (!id || !/^[A-Za-z0-9_.:-]{1,512}$/.test(id)) {
      throw new ApiError(
        409,
        "OpenAPPA withheld an invalid child launch acknowledgment",
      );
    }
    return JSON.stringify({ agent_id: id });
  }

  spawnPromptField(
    name: string,
    args: Record<string, unknown>,
  ): AppaSpawnPromptField | undefined {
    if (!SPAWN_TOOLS.has(localToolName(name))) return undefined;
    // spawn_agent takes its prompt as a message or as input items, never both.
    if (typeof args.message === "string" && args.message.trim().length > 0)
      return { field: "message", kind: "text" };
    if (Array.isArray(args.items) && args.items.length > 0)
      return { field: "items", kind: "items" };
    return undefined;
  }

  nativeConversationId(context: AppaMatchContext): string | undefined {
    // The request thread, which child subagents report as parent_thread_id.
    const turn = parseJsonHeader(context.headers, "x-codex-turn-metadata");
    const body = asRecord(context.requestBody);
    const metadata =
      asRecord(body?.client_metadata) ?? asRecord(body?.metadata);
    return (
      this.extractSessionIdentity(context)?.sessionId ??
      stringField(turn?.thread_id) ??
      stringField(body?.prompt_cache_key) ??
      stringField(metadata?.thread_id) ??
      codexClientMetadataSessionId(body?.client_metadata) ??
      undefined
    );
  }

  nativeSpawnParentId(
    context: AppaMatchContext,
    sessionId: string,
  ): string | undefined {
    const parent = parentThreadId(context);
    return parent && parent !== sessionId ? parent : undefined;
  }

  namesChildren(params: { rootId: string; arguments: unknown }): string[] {
    return namesChildrenFromArguments({
      rootId: params.rootId,
      arguments: params.arguments,
      pathPatterns: [],
      idKeys: CHILD_ID_KEYS,
    });
  }

  bindChildTrajectory(context: AppaMatchContext) {
    const parentNativeId = parentThreadId(context);
    const childNativeId = childThreadId(context, parentNativeId);
    return bindMintedChildTrajectory({
      context,
      parentNativeId,
      childNativeId,
    });
  }

  stripCarrierMetadata(request: unknown): void {
    const body = asRecord(request);
    if (!body) return;
    stripRecordFields(asRecord(body.client_metadata), [
      "agent_id",
      "parent_thread_id",
      "child_thread_id",
      "parent_id",
      "x-codex-parent-thread-id",
      "x-codex-turn-metadata",
    ]);
    stripRecordFields(asRecord(body.metadata), [
      "agent_id",
      "parent_thread_id",
      "child_thread_id",
      "parent_id",
      "x-codex-parent-thread-id",
      "x-codex-turn-metadata",
    ]);
  }
}

function isNativeCodexNamespace(namespace: string | undefined): boolean {
  return (
    namespace === undefined ||
    namespace === "functions" ||
    namespace === "multi_agent_v1"
  );
}

/**
 * Reads the identity pair out of one turn-metadata claim. The blob arrives as
 * a JSON string on the compat header and as an object or JSON string under
 * `client_metadata`; any other shape is the client's own reserved key misused,
 * which is refused rather than guessed at.
 */
function turnMetadataClaims(
  value: unknown,
): { sessionId?: string; threadId?: string } | undefined {
  if (value === undefined) return undefined;
  const record =
    typeof value === "string" ? parseTurnMetadataJson(value) : asRecord(value);
  if (!record) {
    throw new ApiError(
      400,
      "OpenAPPA cannot read malformed Codex trajectory metadata",
    );
  }
  return idClaims(record, "x-codex-turn-metadata");
}

function idClaims(
  record: Record<string, unknown>,
  source: string,
): { sessionId?: string; threadId?: string } {
  const sessionId = idField(record.session_id, source);
  const threadId = idField(record.thread_id, source);
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

function idField(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ApiError(
      400,
      `OpenAPPA cannot read malformed Codex trajectory metadata in ${source}`,
    );
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function parseTurnMetadataJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    const record = asRecord(parsed);
    if (record) return record;
  } catch {
    // Handled by the refusal below.
  }
  throw new ApiError(
    400,
    "OpenAPPA cannot read malformed Codex trajectory metadata",
  );
}

function parentThreadId(context: AppaMatchContext): string | undefined {
  const turn = parseJsonHeader(context.headers, "x-codex-turn-metadata");
  const parent =
    stringField(turn?.parent_thread_id) ?? stringField(turn?.parent_id);
  if (parent) return parent;
  const body = asRecord(context.requestBody);
  const metadata = asRecord(body?.client_metadata) ?? asRecord(body?.metadata);
  const nested = turnMetadataRecord(metadata?.["x-codex-turn-metadata"]);
  return (
    stringField(metadata?.parent_thread_id) ??
    stringField(metadata?.parent_id) ??
    stringField(metadata?.["x-codex-parent-thread-id"]) ??
    stringField(nested?.parent_thread_id) ??
    stringField(nested?.parent_id) ??
    undefined
  );
}

function turnMetadataRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value === "string") return parseTurnMetadataJson(value);
  return asRecord(value);
}

function childThreadId(
  context: AppaMatchContext,
  parentNativeId: string | undefined,
): string | undefined {
  const turn = parseJsonHeader(context.headers, "x-codex-turn-metadata");
  const child =
    stringField(turn?.agent_id) ??
    stringField(turn?.thread_id) ??
    stringField(turn?.session_id);
  if (child && child !== parentNativeId) return child;
  const body = asRecord(context.requestBody);
  const metadata = asRecord(body?.client_metadata) ?? asRecord(body?.metadata);
  const nested = turnMetadataClaims(metadata?.["x-codex-turn-metadata"]);
  const fromMetadata =
    stringField(metadata?.agent_id) ??
    stringField(metadata?.child_thread_id) ??
    stringField(metadata?.thread_id) ??
    nested?.threadId;
  return fromMetadata && fromMetadata !== parentNativeId
    ? fromMetadata
    : undefined;
}
