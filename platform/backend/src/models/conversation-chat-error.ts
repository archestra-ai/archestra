import {
  ChatErrorCode,
  type ChatErrorResponse,
  ChatErrorResponseSchema,
} from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type {
  ConversationChatError,
  InsertConversationChatError,
} from "@/types";

class ConversationChatErrorModel {
  static async create(
    data: InsertConversationChatError,
  ): Promise<ConversationChatError> {
    const [chatError] = await db
      .insert(schema.conversationChatErrorsTable)
      .values(data)
      .returning();

    return chatError;
  }

  static async findByConversation(
    conversationId: string,
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
      error: normalizeChatErrorResponse(chatError.error),
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
