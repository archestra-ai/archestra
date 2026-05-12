import { type ChatErrorResponse, ChatErrorResponseSchema } from "@shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
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
}

function normalizeChatErrorResponse(
  error: ChatErrorResponse,
): ChatErrorResponse {
  const parsed = ChatErrorResponseSchema.safeParse(error);
  if (parsed.success) {
    return parsed.data;
  }

  const originalError = error.originalError;
  if (!originalError || originalError.message === undefined) {
    return error;
  }

  return {
    ...error,
    originalError: {
      ...originalError,
      message: stringifyUnknown(originalError.message),
    },
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
