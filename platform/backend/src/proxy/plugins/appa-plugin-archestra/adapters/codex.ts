import { isCodexClientMetadata } from "@archestra/shared";
import type { AppaSessionIdentity } from "@/openappa/wire";
import { ApiError } from "@/types";
import type { AppaClientAdapter } from "../types";
import { readHeader } from "../utils";

/** Identifies Codex Responses requests and normalizes local tool names. */
export class AppaCodexAdapter implements AppaClientAdapter {
  readonly id = "codex" as const;

  matches(context: Parameters<AppaClientAdapter["matches"]>[0]): boolean {
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

  classifyToolName(name: string): "gateway" | "local" {
    // `mcp__<server>__<tool>` is a namespace member joined with its
    // `mcp__<server>` namespace: an MCP server's tool, not a Codex built-in.
    return name.startsWith("mcp:") || name.startsWith("mcp__")
      ? "gateway"
      : "local";
  }

  normalizeLocalToolName(name: string): string {
    // Codex decorates local function tools with `functions.` before its native
    // namespace, so remove that decoration before preserving the native name.
    const stripped = name.startsWith("functions.")
      ? name.slice("functions.".length)
      : name;
    return stripped.startsWith("builtin:") || stripped.startsWith("host/")
      ? stripped
      : `builtin:${stripped}`;
  }

  /**
   * Codex stamps its trajectory on every request in turn metadata: the
   * canonical `client_metadata["x-codex-turn-metadata"]` body blob, its flat
   * `client_metadata` compat keys, and the compat `x-codex-turn-metadata`
   * header. The root is the durable `thread_id`: a resume replays the same
   * thread under a fresh per-run `session_id`, a fork mints a new thread,
   * and a compaction turn stays on its thread, so thread-rooted identity
   * gives reopen-on-resume, fresh-root-on-fork, and same-root-on-compaction
   * with no proxy state. Subagent threads carry `parent_thread_id`; until the
   * child flow exists they govern as roots of their own. Claims that
   * contradict each other are refused rather than resolved by precedence.
   */
  extractSessionIdentity(context: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    requestBody: unknown;
  }): AppaSessionIdentity | undefined {
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
    // `forked_from_thread_id` marks the client's fork, but the runtime only
    // opens a child on a spawn the parent prepared — a bare parent id would
    // refuse the session outright. A client fork opens a fresh root instead.
    const root = threadId ?? sessionId;
    return root
      ? { sessionId: root, provenance: "codex-turn-metadata" }
      : undefined;
  }
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
