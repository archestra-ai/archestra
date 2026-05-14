import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

const A2AMessageContentSchema = z.unknown();

export const SelectA2AMessageSchema = createSelectSchema(
  schema.a2aMessagesTable,
  {
    content: A2AMessageContentSchema,
  },
);
export const InsertA2AMessageSchema = createInsertSchema(
  schema.a2aMessagesTable,
  {
    content: A2AMessageContentSchema,
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const InsertA2AMessageWithIdSchema = createInsertSchema(
  schema.a2aMessagesTable,
  {
    content: A2AMessageContentSchema,
  },
).omit({
  createdAt: true,
  updatedAt: true,
});

export type A2AMessage = z.infer<typeof SelectA2AMessageSchema>;
export type InsertA2AMessage = z.infer<typeof InsertA2AMessageSchema>;
export type InsertA2AMessageWithId = z.infer<
  typeof InsertA2AMessageWithIdSchema
>;
