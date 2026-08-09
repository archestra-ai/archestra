import { TextSearchLanguageSchema } from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { AclEntrySchema } from "./kb-document";

// Shared field overrides for drizzle-zod schema generation.
// `ftsLanguage` is declared here because drizzle-zod widens the `regconfig`
// custom column type to a bare string, which would let any value through to a
// column PostgreSQL will only accept a real text-search config name for.
const extendedFields = {
  acl: z.array(AclEntrySchema),
  embedding: z.array(z.number()).nullable(),
  embedding1024: z.array(z.number()).nullable(),
  embedding768: z.array(z.number()).nullable(),
  embedding384: z.array(z.number()).nullable(),
  embedding3072: z.array(z.number()).nullable(),
  ftsLanguage: TextSearchLanguageSchema,
};

export const SelectKbChunkSchema = createSelectSchema(
  schema.kbChunksTable,
  extendedFields,
);
export const InsertKbChunkSchema = createInsertSchema(schema.kbChunksTable, {
  acl: z.array(AclEntrySchema).optional(),
  embedding: z.array(z.number()).nullable().optional(),
  embedding1024: z.array(z.number()).nullable().optional(),
  embedding768: z.array(z.number()).nullable().optional(),
  embedding384: z.array(z.number()).nullable().optional(),
  embedding3072: z.array(z.number()).nullable().optional(),
  ftsLanguage: TextSearchLanguageSchema.optional(),
}).omit({ id: true, createdAt: true, searchVector: true });

export type KbChunk = z.infer<typeof SelectKbChunkSchema>;
export type InsertKbChunk = z.infer<typeof InsertKbChunkSchema>;
