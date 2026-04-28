import { z } from "zod";
import {
  MemoryConfidenceBandSchema,
  MemoryKindSchema,
  MemoryScopeTypeSchema,
} from "./memory-item";

export const MemoryCandidateSourceRoleSchema = z.enum([
  "user",
  "assistant",
  "mixed",
]);

export const MemoryCandidateEvidenceSchema = z.object({
  role: z.enum(["user", "assistant"]),
  quote: z.string().min(1).max(500),
  messageId: z.string().min(1).optional(),
});

export const MemoryCandidateSchema = z.object({
  kind: MemoryKindSchema,
  scopeType: MemoryScopeTypeSchema,
  content: z.string().min(1).max(500),
  confidenceBand: MemoryConfidenceBandSchema,
  rationale: z.string().optional(),
  sourceRole: MemoryCandidateSourceRoleSchema.default("assistant"),
  userConfirmed: z.boolean().default(false),
  evidence: z.array(MemoryCandidateEvidenceSchema).max(5).default([]),
});

export const ExtractorOutputSchema = z.object({
  candidates: z.array(MemoryCandidateSchema).max(5),
});

export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;
export type ExtractorOutput = z.infer<typeof ExtractorOutputSchema>;
