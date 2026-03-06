import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const EmbeddingStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
]);
export type EmbeddingStatus = z.infer<typeof EmbeddingStatusSchema>;

export const DocumentSourceTypeSchema = z.enum(["connector", "api"]);
export type DocumentSourceType = z.infer<typeof DocumentSourceTypeSchema>;

export const SelectKbDocumentSchema = createSelectSchema(
  schema.kbDocumentsTable,
  {
    sourceType: DocumentSourceTypeSchema,
    embeddingStatus: EmbeddingStatusSchema,
    acl: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()).nullable(),
  },
);
export const InsertKbDocumentSchema = createInsertSchema(
  schema.kbDocumentsTable,
  {
    sourceType: DocumentSourceTypeSchema,
    embeddingStatus: EmbeddingStatusSchema.optional(),
    acl: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateKbDocumentSchema = createUpdateSchema(
  schema.kbDocumentsTable,
  {
    embeddingStatus: EmbeddingStatusSchema.optional(),
    acl: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  },
).pick({
  title: true,
  content: true,
  contentHash: true,
  sourceUrl: true,
  acl: true,
  metadata: true,
  embeddingStatus: true,
  chunkCount: true,
});

export type KbDocument = z.infer<typeof SelectKbDocumentSchema>;
export type InsertKbDocument = z.infer<typeof InsertKbDocumentSchema>;
export type UpdateKbDocument = z.infer<typeof UpdateKbDocumentSchema>;
