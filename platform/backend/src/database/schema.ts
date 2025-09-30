import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

export const MessageContentSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  tool_call_id: z.string().nullable().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal("function"),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      }),
    )
    .nullable()
    .optional(),
});

export type MessageContent = z.infer<typeof MessageContentSchema>;

export const chatsTable = pgTable("chats", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Interactions table - stores chat messages and tool interactions
 */
export const interactionsTable = pgTable(
  "interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chatsTable.id, { onDelete: "cascade" }),
    content: jsonb("content").$type<MessageContent>().notNull(),
    tainted: boolean("tainted").notNull().default(false),
    taintReason: text("taint_reason"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    chatIdIdx: index("interactions_chat_id_idx").on(table.chatId),
  }),
);

// Base schemas from Drizzle
export const SelectChatSchema = createSelectSchema(chatsTable);
export const InsertChatSchema = createInsertSchema(chatsTable);
export const SelectInteractionSchema = createSelectSchema(interactionsTable, {
  content: MessageContentSchema,
});
export const InsertInteractionSchema = createInsertSchema(interactionsTable, {
  content: MessageContentSchema,
});

// API response schemas - properly typed with relations
export const ChatWithInteractionsSchema = SelectChatSchema.extend({
  interactions: z.array(SelectInteractionSchema),
});

export const CreateChatResponseSchema = SelectChatSchema;

export const GetChatsResponseSchema = z.array(ChatWithInteractionsSchema);

export const GetChatResponseSchema = ChatWithInteractionsSchema;

// Type exports
export type Chat = z.infer<typeof SelectChatSchema>;
export type ChatWithInteractions = z.infer<typeof ChatWithInteractionsSchema>;
export type Interaction = z.infer<typeof SelectInteractionSchema>;
export type InsertChat = z.infer<typeof InsertChatSchema>;
export type InsertInteraction = z.infer<typeof InsertInteractionSchema>;
