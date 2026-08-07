import {
  ChatErrorCode,
  type ChatErrorResponse,
  ChatErrorResponseSchema,
  incognitoLockedContent,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import {
  decryptIncognitoValue,
  encryptIncognitoValue,
  type IncognitoAuditContext,
} from "@/content-encryption/incognito";
import db, { schema } from "@/database";
import logger from "@/logging";
import type {
  ConversationChatError,
  InsertConversationChatError,
} from "@/types";
import { isContentEnvelope } from "@/utils/crypto";

class ConversationChatErrorModel {
  static async create(
    data: InsertConversationChatError,
    auditContext?: IncognitoAuditContext | null,
  ): Promise<ConversationChatError> {
    const [chatError] = await db
      .insert(schema.conversationChatErrorsTable)
      .values(
        auditContext
          ? {
              ...data,
              error: encryptIncognitoValue(data.error, {
                ...auditContext,
                context: CHAT_ERROR_CONTEXT,
              }) as ChatErrorResponse,
            }
          : data,
      )
      .returning();

    return chatError;
  }

  /**
   * `auditContext` is only for callers holding the conversation key. Every
   * other reader (the conversation load, share views, scheduled-run summaries)
   * omits it and gets the locked sentinel for incognito rows rather than an
   * exception — one unopenable error row must not fail the whole read.
   */
  static async findByConversation(
    conversationId: string,
    auditContext?: IncognitoAuditContext | null,
  ): Promise<ConversationChatError[]> {
    const chatErrors = await db
      .select()
      .from(schema.conversationChatErrorsTable)
      .where(
        eq(schema.conversationChatErrorsTable.conversationId, conversationId),
      )
      .orderBy(schema.conversationChatErrorsTable.createdAt);

    return chatErrors.map((chatError) => ({
      ...chatError,
      error: readChatError({
        stored: chatError.error,
        conversationId,
        auditContext: auditContext ?? null,
      }),
    }));
  }

  static async deleteByConversation(conversationId: string): Promise<void> {
    await db
      .delete(schema.conversationChatErrorsTable)
      .where(
        eq(schema.conversationChatErrorsTable.conversationId, conversationId),
      );
  }
}

const CHAT_ERROR_CONTEXT = "conversation_chat_errors.error" as const;

/**
 * Decrypt an incognito error row, or degrade it to something serializable.
 *
 * The response schema is a strict `ChatErrorResponse`, so the locked sentinel
 * cannot be the column value itself — it rides in `originalError.raw`, where
 * the UI matches it with `isIncognitoLockedContent`. A DEK that cannot open
 * the row lands here too: the content is stored and escrow-recoverable, so
 * "locked" is the honest answer, and throwing would take the whole
 * conversation load down with it.
 */
function readChatError(params: {
  stored: ChatErrorResponse;
  conversationId: string;
  auditContext: IncognitoAuditContext | null;
}): ChatErrorResponse {
  const { stored, conversationId, auditContext } = params;
  if (!isContentEnvelope(stored)) {
    return normalizeChatErrorResponse(stored);
  }
  if (auditContext) {
    try {
      return normalizeChatErrorResponse(
        decryptIncognitoValue(stored, {
          ...auditContext,
          context: CHAT_ERROR_CONTEXT,
        }) as ChatErrorResponse,
      );
    } catch (error) {
      logger.warn(
        { error, conversationId },
        "[ConversationChatError] incognito error row could not be decrypted with the presented key",
      );
    }
  }
  return {
    code: ChatErrorCode.Unknown,
    message: "Error details are encrypted for this incognito conversation.",
    isRetryable: false,
    originalError: { raw: incognitoLockedContent(conversationId) },
  };
}

function normalizeChatErrorResponse(
  error: ChatErrorResponse,
): ChatErrorResponse {
  const parsed = ChatErrorResponseSchema.safeParse(error);
  if (parsed.success) {
    return parsed.data;
  }

  // first try the targeted fix for the known producer that stored a non-string
  // originalError.message; if the result still doesn't match the schema, fall
  // through to a minimal valid response so the API never serializes garbage
  const originalError = error?.originalError;
  if (originalError && originalError.message !== undefined) {
    const coerced: ChatErrorResponse = {
      ...error,
      originalError: {
        ...originalError,
        message: stringifyUnknown(originalError.message),
      },
    };
    const reparsed = ChatErrorResponseSchema.safeParse(coerced);
    if (reparsed.success) {
      return reparsed.data;
    }
  }

  // surfaces unexpected shapes so a producer regression doesn't stay invisible
  logger.warn(
    {
      parseError: parsed.error.flatten(),
      errorCode:
        typeof error?.code === "string" || typeof error?.code === "number"
          ? error.code
          : undefined,
      errorKeys:
        error && typeof error === "object" ? Object.keys(error) : undefined,
      originalErrorKeys:
        error?.originalError && typeof error.originalError === "object"
          ? Object.keys(error.originalError)
          : undefined,
    },
    "[ConversationChatError] coercing malformed chat error to minimal response",
  );

  return {
    code: ChatErrorCode.Unknown,
    message:
      typeof error?.message === "string"
        ? error.message
        : stringifyUnknown(error),
    isRetryable: false,
  };
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export default ConversationChatErrorModel;
