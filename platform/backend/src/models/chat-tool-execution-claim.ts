import { and, eq } from "drizzle-orm";
import {
  decryptLockedChatValue,
  encryptLockedChatValue,
  type LockedChatAuditContext,
} from "@/content-encryption/locked-chat";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { ChatToolExecutionClaim } from "@/types";
import { isContentEnvelope } from "@/utils/crypto";

/** Upper bound on the replayable content stored on a claim row. */
const MAX_STORED_RESULT_CHARS = 100_000;

type ClaimOutcome =
  | { claimed: true }
  | { claimed: false; existing: ChatToolExecutionClaim.Select | null };

/**
 * A claim is inserted `executing` and its result written later, and replays
 * read it back before any policy runs — so the conversation key has to reach
 * both ends of that lifecycle. Every entry point that touches `result` takes
 * the audit context explicitly; none of them derives it from the row.
 */
class ChatToolExecutionClaimModel {
  static async findByKey(
    params: {
      conversationId: string;
      toolCallId: string;
    },
    auditContext?: LockedChatAuditContext | null,
  ): Promise<ChatToolExecutionClaim.Select | null> {
    const [row] = await db
      .select()
      .from(schema.chatToolExecutionClaimsTable)
      .where(
        and(
          eq(
            schema.chatToolExecutionClaimsTable.conversationId,
            params.conversationId,
          ),
          eq(schema.chatToolExecutionClaimsTable.toolCallId, params.toolCallId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return withDecryptedResult(
      row as ChatToolExecutionClaim.Select,
      auditContext ?? null,
    );
  }

  /**
   * Atomically claim (conversationId, toolCallId) for execution. Exactly one
   * concurrent caller wins; losers get the existing claim to answer from.
   * `existing: null` is a should-not-happen race (row deleted between insert
   * and select) — callers must fail closed on it, never dispatch.
   */
  static async claim(
    params: {
      conversationId: string;
      toolCallId: string;
      toolName: string;
    },
    auditContext?: LockedChatAuditContext | null,
  ): Promise<ClaimOutcome> {
    const [row] = await db
      .insert(schema.chatToolExecutionClaimsTable)
      .values({ ...params, state: "executing" })
      .onConflictDoNothing()
      .returning({ id: schema.chatToolExecutionClaimsTable.id });

    if (row) {
      return { claimed: true };
    }

    const [existing] = await db
      .select()
      .from(schema.chatToolExecutionClaimsTable)
      .where(
        and(
          eq(
            schema.chatToolExecutionClaimsTable.conversationId,
            params.conversationId,
          ),
          eq(schema.chatToolExecutionClaimsTable.toolCallId, params.toolCallId),
        ),
      )
      .limit(1);

    return {
      claimed: false,
      // The loser answers from the winner's row, so it needs the same key the
      // winner wrote under.
      existing: existing
        ? withDecryptedResult(
            existing as ChatToolExecutionClaim.Select,
            auditContext ?? null,
          )
        : null,
    };
  }

  /**
   * Record the winner's terminal outcome. A claim left in `executing` (crash,
   * abort after dispatch, or a failed update here) keeps replays failing
   * closed, which is the safe direction for a possibly-committed external
   * write.
   */
  static async recordOutcome(
    params: {
      conversationId: string;
      toolCallId: string;
      state: Exclude<ChatToolExecutionClaim.State, "executing">;
      result: ChatToolExecutionClaim.StoredResult | null;
    },
    auditContext?: LockedChatAuditContext | null,
  ): Promise<void> {
    await db
      .update(schema.chatToolExecutionClaimsTable)
      .set({
        state: params.state,
        result: encryptClaimResult(params.result, auditContext ?? null),
      })
      .where(
        and(
          eq(
            schema.chatToolExecutionClaimsTable.conversationId,
            params.conversationId,
          ),
          eq(schema.chatToolExecutionClaimsTable.toolCallId, params.toolCallId),
          eq(schema.chatToolExecutionClaimsTable.state, "executing"),
        ),
      );
  }

  /**
   * Build the bounded replay payload from a tool result: plain-text content
   * only — UI/binary metadata (rawContent, _meta, structuredContent) is
   * deliberately dropped.
   */
  static toStoredResult(
    toolResult: string | { content: string },
  ): ChatToolExecutionClaim.StoredResult {
    const resultKind = typeof toolResult === "string" ? "text" : "content";
    const rawContent =
      typeof toolResult === "string" ? toolResult : toolResult.content;
    const content =
      typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent);
    return {
      resultKind,
      content: content.slice(0, MAX_STORED_RESULT_CHARS),
      truncated: content.length > MAX_STORED_RESULT_CHARS,
    };
  }
}

export default ChatToolExecutionClaimModel;

// === Internal ===

const CLAIM_RESULT_CONTEXT = "chat_tool_execution_claims.result" as const;

function encryptClaimResult(
  result: ChatToolExecutionClaim.StoredResult | null,
  auditContext: LockedChatAuditContext | null,
): ChatToolExecutionClaim.StoredResult | null {
  if (!result || !auditContext) return result;
  // The whole payload is wrapped, not just `content`: `truncated` and
  // `resultKind` are derived from the result and the column is typed to the
  // object, so splitting them would leak shape and still need a cast.
  return encryptLockedChatValue(result, {
    ...auditContext,
    context: CLAIM_RESULT_CONTEXT,
  }) as ChatToolExecutionClaim.StoredResult;
}

/**
 * Fail closed on a result this caller cannot open. A null result makes the
 * replay builder answer "already dispatched, do not re-run" — the safe
 * direction for a possibly-committed external write. Only reachable if a
 * conversation's key situation changed under us; normal reads carry the
 * writer's key.
 */
function withDecryptedResult(
  row: ChatToolExecutionClaim.Select,
  auditContext: LockedChatAuditContext | null,
): ChatToolExecutionClaim.Select {
  if (!isContentEnvelope(row.result)) return row;
  if (auditContext) {
    try {
      return {
        ...row,
        result: decryptLockedChatValue(row.result, {
          ...auditContext,
          context: CLAIM_RESULT_CONTEXT,
        }) as ChatToolExecutionClaim.StoredResult,
      };
    } catch (error) {
      logger.warn(
        { error, toolCallId: row.toolCallId },
        "Tool execution claim result could not be decrypted; replay will fail closed",
      );
    }
  }
  return { ...row, result: null };
}
