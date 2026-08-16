import { lockedChatSealedContent } from "@archestra/shared";
import { isContentEnvelope } from "@/utils/crypto";
import {
  decryptLockedChatValue,
  encryptLockedChatValue,
  type LockedChatAuditContext,
  type LockedChatContentContext,
} from "./locked-chat";
import {
  decryptInteractionRow,
  decryptMcpToolCallRow,
  encryptInteractionInsert,
  encryptMcpToolCallInsert,
  // biome-ignore lint/style/noRestrictedImports: dual-licensed; server-key at-rest encryption is enterprise and is a no-op without it
} from "./rows.ee";

/**
 * The single funnel deciding which key an audit row's content is written
 * under. Exactly one branch runs per row:
 *
 * - with a locked-chat audit context → the conversation's browser-held DEK,
 *   and the row is stamped with `lockedChatConversationId` so readers know not
 *   to attempt a server-key decrypt and break-glass knows which escrow record
 *   opens it;
 * - without one → the at-rest server key (itself a no-op when content
 *   encryption is disabled, leaving plaintext).
 *
 * Callers MUST NOT pre-encrypt. Every insert path already runs through here,
 * so encrypting beforehand would produce a nested envelope.
 */

/** Encrypt an interaction insert's content columns, in place. */
export function encryptInteractionContent<T extends object>(
  values: T,
  audit: LockedChatAuditContext | null,
): T {
  if (!audit) return encryptInteractionInsert(values);
  return encryptUnderDek(values, INTERACTION_COLUMN_CONTEXTS, audit);
}

/** Encrypt an MCP tool-call insert's content columns, in place. */
export function encryptMcpToolCallContent<T extends object>(
  values: T,
  audit: LockedChatAuditContext | null,
): T {
  if (!audit) return encryptMcpToolCallInsert(values);
  return encryptUnderDek(values, MCP_TOOL_CALL_COLUMN_CONTEXTS, audit);
}

/**
 * Read-path counterpart for interaction rows: locked-safe.
 *
 * A row belonging to a locked chat is keyed to a browser the
 * server does not have, so its content columns are replaced with the locked
 * sentinel rather than decrypted — attempting a server-key decrypt on them
 * throws, and one such row would otherwise 500 an entire logs page. Ordinary
 * rows decrypt as before.
 *
 * Use this at EVERY read site. `decryptInteractionContent` is only for callers
 * that hold the conversation key.
 */
export function readInteractionRow<T extends object>(row: T): T {
  const lockedTo = lockedConversationId(row);
  if (lockedTo === null) return decryptInteractionRow(row);
  return applyLockedSentinel(row, INTERACTION_COLUMN_CONTEXTS, lockedTo);
}

/** Read-path counterpart for MCP tool-call rows: locked-safe. */
export function readMcpToolCallRow<T extends object>(row: T): T {
  const lockedTo = lockedConversationId(row);
  if (lockedTo === null) return decryptMcpToolCallRow(row);
  return applyLockedSentinel(row, MCP_TOOL_CALL_COLUMN_CONTEXTS, lockedTo);
}

/**
 * Decrypt an interaction row that was written under a known audit context.
 * Only for callers that hold the conversation key (the write path's RETURNING
 * row, and break-glass recovery). Read paths that may encounter a row whose
 * key they do NOT hold must use the locked-row guards instead — decrypting
 * without the right key throws by design.
 */
export function decryptInteractionContent<T extends object>(
  row: T,
  audit: LockedChatAuditContext | null,
): T {
  if (!audit) return decryptInteractionRow(row);
  return decryptUnderDek(row, INTERACTION_COLUMN_CONTEXTS, audit);
}

/** Decrypt an MCP tool-call row written under a known audit context. */
export function decryptMcpToolCallContent<T extends object>(
  row: T,
  audit: LockedChatAuditContext | null,
): T {
  if (!audit) return decryptMcpToolCallRow(row);
  return decryptUnderDek(row, MCP_TOOL_CALL_COLUMN_CONTEXTS, audit);
}

// === Internal ===

/**
 * camelCase (drizzle) and snake_case (raw SQL) spellings of each encrypted
 * column, mapped to its AAD context. Mirrors the at-rest layer's table so a
 * column's AAD reads identically under either key.
 */
const INTERACTION_COLUMN_CONTEXTS: Array<[string, LockedChatContentContext]> = [
  ["request", "interactions.request"],
  ["processedRequest", "interactions.processed_request"],
  ["processed_request", "interactions.processed_request"],
  ["response", "interactions.response"],
  ["dualLlmAnalyses", "interactions.dual_llm_analyses"],
  ["dual_llm_analyses", "interactions.dual_llm_analyses"],
  ["unsafeContextBoundary", "interactions.unsafe_context_boundary"],
  ["unsafe_context_boundary", "interactions.unsafe_context_boundary"],
];

const MCP_TOOL_CALL_COLUMN_CONTEXTS: Array<[string, LockedChatContentContext]> =
  [
    ["toolCall", "mcp_tool_calls.tool_call"],
    ["tool_call", "mcp_tool_calls.tool_call"],
    ["toolResult", "mcp_tool_calls.tool_result"],
    ["tool_result", "mcp_tool_calls.tool_result"],
  ];

function encryptUnderDek<T extends object>(
  values: T,
  columns: Array<[string, LockedChatContentContext]>,
  audit: LockedChatAuditContext,
): T {
  const target = values as Record<string, unknown>;
  for (const [key, context] of columns) {
    if (key in target && target[key] !== null && target[key] !== undefined) {
      target[key] = encryptLockedChatValue(target[key], { ...audit, context });
    }
  }
  // Stamped by the funnel, never by callers: a row carrying the discriminator
  // without DEK ciphertext (or vice versa) is unreadable, so the two must be
  // set together in one place — and in one INSERT, never insert-then-update.
  target.lockedChatConversationId = audit.conversationId;
  return values;
}

/**
 * The conversation this row's content is keyed to, or null when it is not an
 * locked-chat row. Accepts both spellings because raw-SQL reads return
 * snake_case while Drizzle selects return camelCase — a read site that fed the
 * wrong one in would silently fall through to a server-key decrypt and throw,
 * so both are checked here rather than at each call site.
 */
function lockedConversationId(row: object): string | null {
  const target = row as Record<string, unknown>;
  const value =
    target.lockedChatConversationId ?? target.locked_chat_conversation_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Columns nulled rather than sentinelled when locked. Their readers treat them
 * as an array or a fixed shape throughout — substituting an object there makes
 * every consumer learn a shape it otherwise never sees, and each one that
 * doesn't is a crash. They are supporting detail anyway: a locked row already
 * announces itself through request/response, which readers handle as opaque
 * payloads.
 */
const NULLED_WHEN_LOCKED = new Set([
  "dualLlmAnalyses",
  "dual_llm_analyses",
  "unsafeContextBoundary",
  "unsafe_context_boundary",
]);

function applyLockedSentinel<T extends object>(
  row: T,
  columns: Array<[string, LockedChatContentContext]>,
  conversationId: string,
): T {
  const target = row as Record<string, unknown>;
  for (const [key] of columns) {
    // Only columns actually selected, and only ones holding an envelope: a
    // null column stays null, and the fail-closed redaction marker keeps its
    // own meaning ("never stored") rather than being relabelled recoverable.
    if (key in target && isContentEnvelope(target[key])) {
      target[key] = NULLED_WHEN_LOCKED.has(key)
        ? null
        : lockedChatSealedContent(conversationId);
    }
  }
  return row;
}

function decryptUnderDek<T extends object>(
  row: T,
  columns: Array<[string, LockedChatContentContext]>,
  audit: LockedChatAuditContext,
): T {
  const target = row as Record<string, unknown>;
  for (const [key, context] of columns) {
    if (key in target) {
      target[key] = decryptLockedChatValue(target[key], { ...audit, context });
    }
  }
  return row;
}
