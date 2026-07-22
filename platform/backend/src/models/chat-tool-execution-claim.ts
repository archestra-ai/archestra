import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ChatToolExecutionClaim } from "@/types";

/** Upper bound on the replayable content stored on a claim row. */
const MAX_STORED_RESULT_CHARS = 100_000;

type ClaimOutcome =
  | { claimed: true }
  | { claimed: false; existing: ChatToolExecutionClaim.Select | null };

class ChatToolExecutionClaimModel {
  static async findByKey(params: {
    conversationId: string;
    toolCallId: string;
  }): Promise<ChatToolExecutionClaim.Select | null> {
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
    return (row as ChatToolExecutionClaim.Select) ?? null;
  }

  /**
   * Atomically claim (conversationId, toolCallId) for execution. Exactly one
   * concurrent caller wins; losers get the existing claim to answer from.
   * `existing: null` is a should-not-happen race (row deleted between insert
   * and select) — callers must fail closed on it, never dispatch.
   */
  static async claim(params: {
    conversationId: string;
    toolCallId: string;
    toolName: string;
  }): Promise<ClaimOutcome> {
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
      existing: (existing as ChatToolExecutionClaim.Select) ?? null,
    };
  }

  /**
   * Record the winner's terminal outcome. A claim left in `executing` (crash,
   * abort after dispatch, or a failed update here) keeps replays failing
   * closed, which is the safe direction for a possibly-committed external
   * write.
   */
  static async recordOutcome(params: {
    conversationId: string;
    toolCallId: string;
    state: Exclude<ChatToolExecutionClaim.State, "executing">;
    result: ChatToolExecutionClaim.StoredResult | null;
  }): Promise<void> {
    await db
      .update(schema.chatToolExecutionClaimsTable)
      .set({ state: params.state, result: params.result })
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
