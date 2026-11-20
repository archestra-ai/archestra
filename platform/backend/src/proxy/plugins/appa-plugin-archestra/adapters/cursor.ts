import { createHash } from "node:crypto";
import { isCursorUserAgent } from "@archestra/shared";
import type { AppaSessionIdentity } from "@/openappa/wire";
import { asRecord } from "@/utils/as-record";
import type { AppaClientAdapter, AppaMatchContext } from "../types";
import { readHeader } from "../utils";

/**
 * Cursor's BYOK model requests come from Cursor's own servers, on the OpenAI
 * wires, with `User-Agent: Cursor/<version>` as the only client signal. No
 * field is known to name the chat: `user` names the device, and the meaning
 * of `prompt_cache_key`, `metadata` and `conversation` for Cursor is
 * unverified, so none of them is read as a session.
 *
 * A chat is named by its opening instead: a digest of its first user
 * message, which the proxy scopes to the caller. Chats that open alike share
 * that session, but only until each makes a tool call: the provider's id for
 * the call is the chat's own, and from then on the chat is named by its
 * opening and that id. The call carries the shared session's trajectory
 * stamp, so the new name is a fork of that session (`openappa/lineage.ts`):
 * it keeps the session's restrictions, and what one chat reads or is allowed
 * from then on does not reach the other. A provider that repeats call ids
 * across responses leaves such chats in one session.
 *
 * A history whose opening changed (a summary, an edited first message) is a
 * fork of the stamped session in the same way.
 *
 * Cursor has no known native question, spawn, or carrier protocol on this
 * wire, so those stay off.
 */
export class AppaCursorAdapter implements AppaClientAdapter {
  readonly id = "cursor";
  readonly trajectoryPrefix = "cursor";
  readonly genericSessionFallback = false;

  matches(context: AppaMatchContext): boolean {
    return isCursorUserAgent(readHeader(context.headers, "user-agent"));
  }

  classifyToolName(name: string, namespace?: string): "gateway" | "local" {
    // Cursor's own tools are bare names (`Read`, `ApplyPatch`). MCP tools
    // carry an `mcp` prefix, or the gateway's `<server>__<tool>` separator.
    return name.startsWith("mcp_") ||
      name.startsWith("mcp:") ||
      name.includes("__") ||
      namespace?.startsWith("mcp__")
      ? "gateway"
      : "local";
  }

  normalizeLocalToolName(name: string): string {
    return name;
  }

  /** The chat named by its opening, or undefined for a request with none. */
  extractSessionIdentity(
    context: AppaMatchContext,
  ): AppaSessionIdentity | undefined {
    const opening = openingText(context.requestBody);
    if (opening === undefined) return undefined;
    const firstCall = firstCallId(context.requestBody);
    return {
      sessionId: chatName(
        firstCall === undefined ? [opening] : [opening, firstCall],
      ),
      provenance: "cursor-opening",
    };
  }

  nativeConversationId(context: AppaMatchContext): string | undefined {
    return this.extractSessionIdentity(context)?.sessionId;
  }

  /**
   * The opening alone: it does not change when the chat makes its first
   * tool call and its session gets a name of its own.
   */
  conversationClaimId(context: AppaMatchContext): string | undefined {
    const opening = openingText(context.requestBody);
    return opening === undefined ? undefined : chatName([opening]);
  }

  gatewayToolsHint(serverName: string): string {
    return `In Cursor, open Cursor Settings > MCP & Integrations (Customize > MCPs in newer versions), turn on ${serverName} and sign in to it, then start a new chat.`;
  }

  isSpawnTool(_name: string): boolean {
    return false;
  }

  spawnPromptField(): undefined {
    return undefined;
  }

  namesChildren(): string[] {
    return [];
  }

  bindChildTrajectory(): undefined {
    return undefined;
  }

  stripCarrierMetadata(): void {}
}

// === Internal helpers ===

const CURSOR_SESSION_PREFIX = "cursor-chat-";
const OPENING_DOMAIN = "archestra-cursor-opening-v1";

/** A chat's name: a digest of what tells it apart from other chats. */
function chatName(parts: readonly string[]): string {
  const digest = createHash("sha256")
    .update([OPENING_DOMAIN, ...parts].join("\u0000"), "utf8")
    .digest("base64url")
    .slice(0, 32);
  return `${CURSOR_SESSION_PREFIX}${digest}`;
}

/**
 * The text of the first user message, on Chat Completions (`messages`) or
 * Responses (`input`), with runs of whitespace collapsed. The system prompt
 * is left out: Cursor builds it per request, and its stability is unverified.
 */
function openingText(requestBody: unknown): string | undefined {
  const body = asRecord(requestBody);
  if (!body) return undefined;
  const items = Array.isArray(body.messages)
    ? body.messages
    : typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : Array.isArray(body.input)
        ? body.input
        : [];
  for (const item of items) {
    const message = asRecord(item);
    if (message?.role !== "user") continue;
    const text = contentText(message.content).replace(/\s+/g, " ").trim();
    return text === "" ? undefined : text;
  }
  return undefined;
}

/**
 * The id of the first tool call in the history. The proxy hands the adapter
 * the provider's own id, with its trajectory stamp taken off.
 */
function firstCallId(requestBody: unknown): string | undefined {
  const body = asRecord(requestBody);
  if (!body) return undefined;
  const items = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : [];
  for (const item of items) {
    const entry = asRecord(item);
    if (!entry) continue;
    // Chat Completions: an assistant message's tool calls. Responses: an
    // item of its own.
    const calls = Array.isArray(entry.tool_calls)
      ? entry.tool_calls
      : entry.type === "function_call"
        ? [{ id: entry.call_id }]
        : [];
    for (const call of calls) {
      const id = asRecord(call)?.id;
      if (typeof id === "string" && id !== "") return id;
    }
  }
  return undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const text = asRecord(part)?.text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}
