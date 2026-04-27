import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const MemoryScopeTypeSchema = z.enum(["user", "team", "organization"]);
export type MemoryScopeType = z.infer<typeof MemoryScopeTypeSchema>;

export const MemoryStatusSchema = z.enum([
  "candidate",
  "approved",
  "rejected",
  "archived",
]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemoryKindSchema = z.enum([
  "preference",
  "profile_fact",
  "instruction",
  "team_convention",
  "org_fact",
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemoryRejectionReasonSchema = z.enum([
  "inaccurate",
  "sensitive",
  "manipulative",
  "wrong_scope",
  "temporary",
  "duplicate",
  "vague",
  "not_useful",
  "conflicts_with_existing",
  "policy_violation",
]);
export type MemoryRejectionReason = z.infer<typeof MemoryRejectionReasonSchema>;

export const MemoryPolicyFlagSchema = z.enum([
  "instruction_like",
  "instruction_like_high",
  "instruction_like_medium",
  "external_context",
  "source_deleted",
]);
export type MemoryPolicyFlag = z.infer<typeof MemoryPolicyFlagSchema>;

export const MemoryConfidenceBandSchema = z.enum(["low", "medium", "high"]);
export type MemoryConfidenceBand = z.infer<typeof MemoryConfidenceBandSchema>;

export const MemorySourceTypeSchema = z.enum([
  "chat",
  "manual",
  "mcp_tool",
  "api",
  "import",
  "system",
]);
export type MemorySourceType = z.infer<typeof MemorySourceTypeSchema>;

export const MemorySourceMetadataOriginSchema = z
  .object({
    conversationId: z.string().optional(),
    messageIds: z.array(z.string()).optional(),
    messageRange: z
      .object({
        from: z.string().optional(),
        to: z.string().optional(),
      })
      .optional(),
    channel: z.string().optional(),
    toolName: z.string().optional(),
  })
  .passthrough();

export const MemorySourceMetadataIngestionSchema = z
  .object({
    runId: z.string().min(1),
    idempotencyKey: z.string().optional(),
    dedupKey: z.string().optional(),
    ingestedAt: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();

export const MemorySourceMetadataActorSchema = z
  .object({
    kind: z.enum(["user", "agent", "system"]),
    userId: z.string().optional(),
    agentId: z.string().optional(),
  })
  .passthrough();

export const MemorySourceMetadataQualitySchema = z
  .object({
    extractorVersion: z.string().optional(),
    confidenceBand: MemoryConfidenceBandSchema.optional(),
  })
  .passthrough();

export const MemorySourceMetadataSafetySchema = z
  .object({
    policyFlags: z.array(MemoryPolicyFlagSchema),
    sourceDeleted: z.boolean().optional(),
    sourceDeletedAt: z.string().datetime({ offset: true }).optional(),
  })
  .passthrough();

export const MemorySourceMetadataFutureSchema = z
  .object({
    projectId: z.string().nullable().optional(),
    workspaceId: z.string().nullable().optional(),
    sectionId: z.string().nullable().optional(),
  })
  .passthrough();

export const MemorySourceMetadataSchema = z
  .object({
    origin: MemorySourceMetadataOriginSchema,
    ingestion: MemorySourceMetadataIngestionSchema,
    actor: MemorySourceMetadataActorSchema,
    quality: MemorySourceMetadataQualitySchema,
    safety: MemorySourceMetadataSafetySchema,
    future: MemorySourceMetadataFutureSchema,
  })
  .passthrough();

export type MemorySourceMetadata = z.infer<typeof MemorySourceMetadataSchema>;
export type MemorySourceMetadataFuture = z.infer<
  typeof MemorySourceMetadataFutureSchema
>;

const extendedFields = {
  scopeType: MemoryScopeTypeSchema,
  kind: MemoryKindSchema,
  status: MemoryStatusSchema,
  rejectionReason: MemoryRejectionReasonSchema.nullable(),
  policyFlags: z.array(MemoryPolicyFlagSchema),
  confidenceBand: MemoryConfidenceBandSchema.nullable(),
  sourceType: MemorySourceTypeSchema.nullable(),
  sourceId: z.string().nullable(),
  sourceMetadata: MemorySourceMetadataSchema.nullable(),
};

export const SelectMemoryItemSchema = createSelectSchema(
  schema.memoryItemsTable,
  extendedFields,
);

export const InsertMemoryItemSchema = createInsertSchema(
  schema.memoryItemsTable,
  {
    ...extendedFields,
    status: MemoryStatusSchema.optional(),
    rejectionReason: MemoryRejectionReasonSchema.nullable().optional(),
    policyFlags: z.array(MemoryPolicyFlagSchema).optional(),
    confidenceBand: MemoryConfidenceBandSchema.nullable().optional(),
    sourceType: MemorySourceTypeSchema.nullable().optional(),
    sourceId: z.string().nullable().optional(),
    sourceMetadata: MemorySourceMetadataSchema.nullable().optional(),
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const UpdateMemoryItemSchema = createUpdateSchema(
  schema.memoryItemsTable,
  {
    ...extendedFields,
    rejectionReason: MemoryRejectionReasonSchema.nullable().optional(),
    policyFlags: z.array(MemoryPolicyFlagSchema).optional(),
    confidenceBand: MemoryConfidenceBandSchema.nullable().optional(),
  },
).pick({
  content: true,
  kind: true,
  rejectionReason: true,
  rejectionComment: true,
  reviewedBy: true,
  reviewedAt: true,
  lastVerifiedAt: true,
  expiresAt: true,
});

export const SupersedeMemoryItemSchema = z.object({
  content: z.string().min(1).max(500),
  kind: MemoryKindSchema.optional(),
});

export type MemoryItem = z.infer<typeof SelectMemoryItemSchema>;
export type InsertMemoryItem = z.infer<typeof InsertMemoryItemSchema>;
export type UpdateMemoryItem = z.infer<typeof UpdateMemoryItemSchema>;
