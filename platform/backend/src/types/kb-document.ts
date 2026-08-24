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

/**
 * A predicate over a document's connector-supplied `metadata`, narrowing a
 * search to a subset of the documents a connector has already indexed.
 *
 * Each entry is one metadata key and the value(s) that satisfy it. A document
 * matches when EVERY key matches (AND across keys) and, for each key, its
 * stored value is — or contains — ANY of the listed values (OR within a key).
 *
 * Both shapes are accepted per key because connectors emit both: Confluence
 * writes a scalar `spaceKey` and an array `labels`, GitHub writes a scalar
 * `state` and an array `labels`. A caller should not have to know which.
 *
 * Narrowing only. This never widens what a user may read: the ACL predicate is
 * applied separately and unconditionally, so a filter can only ever remove
 * documents from a result the user was already entitled to see.
 */
export const KbDocumentMetadataFilterSchema = z.record(
  z.string().trim().min(1),
  z.union([z.string(), z.array(z.string()).min(1)]),
);
export type KbDocumentMetadataFilter = z.infer<
  typeof KbDocumentMetadataFilterSchema
>;

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
  // Re-indexing an uploaded file after it moved between directories has to
  // carry the new grouping key, or the document keeps pointing at the
  // directory it left.
  containerKey: true,
});

export type KbDocument = z.infer<typeof SelectKbDocumentSchema>;
export type InsertKbDocument = z.infer<typeof InsertKbDocumentSchema>;
export type UpdateKbDocument = z.infer<typeof UpdateKbDocumentSchema>;
