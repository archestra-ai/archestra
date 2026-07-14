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
 *
 * `container:<connectorId>:<containerKey>` defers the audience to a
 * `kb_container_acls` row; query-time resolution expands a user's base tokens
 * into the container tokens they can read. The connector id is embedded
 * because searches span connectors — without it, same-keyed containers on two
 * connectors would cross-grant.
 */
export type AclEntry =
  | "org:*"
  | `team:${string}`
  | `user_email:${string}`
  | `group:${string}`
  | `container:${string}`;

export const AclEntrySchema = z
  .string()
  .regex(
    /^(org:\*|team:.+|user_email:.+|group:.+|container:.+)$/,
    "ACL entry must match org:*, team:<id>, user_email:<email>, group:<id>, or container:<connectorId>:<key>",
  );

export const EmbeddingStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
]);
export type EmbeddingStatus = z.infer<typeof EmbeddingStatusSchema>;

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
  extendedFields,
);
export const InsertKbDocumentSchema = createInsertSchema(
  schema.kbDocumentsTable,
  {
    ...extendedFields,
    embeddingStatus: EmbeddingStatusSchema.optional(),
    acl: z.array(AclEntrySchema).optional(),
    metadata: KbDocumentMetadataSchema.optional(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateKbDocumentSchema = createUpdateSchema(
  schema.kbDocumentsTable,
  {
    embeddingStatus: EmbeddingStatusSchema.optional(),
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
  chunkCount: true,
});

export type KbDocument = z.infer<typeof SelectKbDocumentSchema>;
export type InsertKbDocument = z.infer<typeof InsertKbDocumentSchema>;
export type UpdateKbDocument = z.infer<typeof UpdateKbDocumentSchema>;
