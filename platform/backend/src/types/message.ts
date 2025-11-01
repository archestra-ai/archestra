import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectMessageSchema = createSelectSchema(schema.messagesTable);
export const InsertMessageSchema = createInsertSchema(
  schema.messagesTable,
).omit({
  id: true,
  createdAt: true,
});

export type Message = z.infer<typeof SelectMessageSchema>;
export type InsertMessage = z.infer<typeof InsertMessageSchema>;
