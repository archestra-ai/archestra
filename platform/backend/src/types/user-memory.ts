import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectUserMemorySchema = createSelectSchema(
  schema.userMemoriesTable,
);

export const InsertUserMemorySchema = createInsertSchema(
  schema.userMemoriesTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const UserMemoryInputSchema = z.object({
  title: z
    .string()
    .min(1, "Title is required")
    .max(200, "Title must be at most 200 characters"),
  content: z
    .string()
    .min(1, "Content is required")
    .max(2000, "Content must be at most 2000 characters"),
});

export const UpdateUserMemorySchema = UserMemoryInputSchema.partial();

export type UserMemory = z.infer<typeof SelectUserMemorySchema>;
export type InsertUserMemory = z.infer<typeof InsertUserMemorySchema>;
export type UserMemoryInput = z.infer<typeof UserMemoryInputSchema>;
