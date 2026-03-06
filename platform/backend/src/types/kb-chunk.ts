import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectKbChunkSchema = createSelectSchema(schema.kbChunksTable, {
  acl: z.array(z.string()),
  embedding: z.array(z.number()).nullable(),
});
export const InsertKbChunkSchema = createInsertSchema(schema.kbChunksTable, {
  acl: z.array(z.string()).optional(),
  embedding: z.array(z.number()).nullable().optional(),
}).omit({ id: true, createdAt: true, searchVector: true });

export type KbChunk = z.infer<typeof SelectKbChunkSchema>;
export type InsertKbChunk = z.infer<typeof InsertKbChunkSchema>;
