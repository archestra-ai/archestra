import { z } from "zod";
import {
  MemoryConfidenceBandSchema,
  MemoryKindSchema,
  MemoryScopeTypeSchema,
} from "./memory-item";

export const MemoryCandidateSchema = z.object({
  kind: MemoryKindSchema,
  scopeType: MemoryScopeTypeSchema,
  content: z.string().min(1).max(500),
  confidenceBand: MemoryConfidenceBandSchema,
  rationale: z.string().optional(),
});

export const ExtractorOutputSchema = z.object({
  candidates: z.array(MemoryCandidateSchema).max(5),
});

export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;
export type ExtractorOutput = z.infer<typeof ExtractorOutputSchema>;
