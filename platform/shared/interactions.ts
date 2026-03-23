import { z } from "zod";

/**
 * Where an LLM proxy request originated from.
 * Stored in the `source` column of the interactions table.
 */
export const InteractionSourceSchema = z.enum([
  "api",
  "chat",
  "chatops:slack",
  "chatops:ms-teams",
  "email",
  "knowledge:embedding",
  "knowledge:reranker",
  "knowledge:query-expansion",
]);

export type InteractionSource = z.infer<typeof InteractionSourceSchema>;

/**
 * Display configuration for interaction sources.
 * Used by both frontend (SourceBadge) and any other consumer that needs
 * human-readable labels for source values.
 */
export const INTERACTION_SOURCE_DISPLAY: Record<
  InteractionSource,
  { label: string }
> = {
  api: { label: "API" },
  chat: { label: "Chat" },
  "chatops:slack": { label: "Slack" },
  "chatops:ms-teams": { label: "MS Teams" },
  email: { label: "Email" },
  "knowledge:embedding": { label: "Knowledge - Embedding" },
  "knowledge:reranker": { label: "Knowledge - Reranker" },
  "knowledge:query-expansion": { label: "Knowledge - Query Expansion" },
};
