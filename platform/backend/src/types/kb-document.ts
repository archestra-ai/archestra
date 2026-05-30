import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * ACL entry type for knowledge base documents and chunks.
 * Used for query-time access control filtering via PostgreSQL's `?|` operator.
 */
export type AclEntry =
  | "org:*"
  | `team:${string}`
  | `user_email:${string}`
  | `group:${string}`;

export const AclEntrySchema = z
  .string()
  .regex(
    /^(org:\*|team:.+|user_email:.+|group:.+)$/,
    "ACL entry must match org:*, team:<id>, user_email:<email>, or group:<id>",
  );

export const EmbeddingStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
]);
export type EmbeddingStatus = z.infer<typeof EmbeddingStatusSchema>;

export const EmbeddingErrorSchema = z.enum([
  "api_unauthorized",
  "api_permission_denied",
  "api_bad_request",
  "api_not_found",
  "api_conflict",
  "api_unprocessable_entity",
  "api_rate_limit",
  "api_generic_error",
  "context_length_exceeded",
  "length_mismatch",
  "dimensions_mismatch",
  "unknown",
]);
export type EmbeddingError = z.infer<typeof EmbeddingErrorSchema>;

export const KbDocumentMetadataSchema = z.record(z.string(), z.unknown());
export type KbDocumentMetadata = z.infer<typeof KbDocumentMetadataSchema>;

// Shared field overrides for drizzle-zod schema generation
const extendedFields = {
  embeddingStatus: EmbeddingStatusSchema,
  acl: z.array(AclEntrySchema),
  metadata: KbDocumentMetadataSchema.nullable(),
};

export const SelectKbDocumentSchema = createSelectSchema(
  schema.kbDocumentsTable,
  {
    ...extendedFields,
    embeddingError: EmbeddingErrorSchema.nullable(),
  },
);
export const InsertKbDocumentSchema = createInsertSchema(
  schema.kbDocumentsTable,
  {
    ...extendedFields,
    embeddingStatus: EmbeddingStatusSchema.optional(),
    embeddingError: EmbeddingErrorSchema.nullable().optional(),
    acl: z.array(AclEntrySchema).optional(),
    metadata: KbDocumentMetadataSchema.optional(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateKbDocumentSchema = createUpdateSchema(
  schema.kbDocumentsTable,
  {
    embeddingStatus: EmbeddingStatusSchema.optional(),
    embeddingError: EmbeddingErrorSchema.nullable().optional(),
    acl: z.array(AclEntrySchema).optional(),
    metadata: KbDocumentMetadataSchema.optional(),
  },
).pick({
  title: true,
  content: true,
  contentHash: true,
  sourceUrl: true,
  acl: true,
  metadata: true,
  embeddingStatus: true,
  embeddingError: true,
  chunkCount: true,
});

export type KbDocument = z.infer<typeof SelectKbDocumentSchema>;
export type InsertKbDocument = z.infer<typeof InsertKbDocumentSchema>;
export type UpdateKbDocument = z.infer<typeof UpdateKbDocumentSchema>;
