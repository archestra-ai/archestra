import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { AclEntrySchema } from "./kb-document";

// Shared field overrides for drizzle-zod schema generation
const extendedFields = {
  acl: z.array(AclEntrySchema),
  embedding: z.array(z.number()).nullable(),
  embedding768: z.array(z.number()).nullable(),
  embedding3072: z.array(z.number()).nullable(),
};

export const SelectKbChunkSchema = createSelectSchema(
  schema.kbChunksTable,
  extendedFields,
);
export const InsertKbChunkSchema = createInsertSchema(schema.kbChunksTable, {
  acl: z.array(AclEntrySchema).optional(),
  embedding: z.array(z.number()).nullable().optional(),
  embedding768: z.array(z.number()).nullable().optional(),
  embedding3072: z.array(z.number()).nullable().optional(),
}).omit({ id: true, createdAt: true, searchVector: true });

export type KbChunk = z.infer<typeof SelectKbChunkSchema>;
export type InsertKbChunk = z.infer<typeof InsertKbChunkSchema>;
