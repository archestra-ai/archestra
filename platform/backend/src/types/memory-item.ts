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
  "external_context",
  "source_deleted",
]);
export type MemoryPolicyFlag = z.infer<typeof MemoryPolicyFlagSchema>;

export const MemoryConfidenceBandSchema = z.enum(["low", "medium", "high"]);
export type MemoryConfidenceBand = z.infer<typeof MemoryConfidenceBandSchema>;

const extendedFields = {
  scopeType: MemoryScopeTypeSchema,
  kind: MemoryKindSchema,
  status: MemoryStatusSchema,
  rejectionReason: MemoryRejectionReasonSchema.nullable(),
  policyFlags: z.array(MemoryPolicyFlagSchema),
  confidenceBand: MemoryConfidenceBandSchema.nullable(),
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
