import { z } from "zod";

/**
 * Knowledge base visibility
 */
export const KnowledgeBaseVisibilitySchema = z.enum([
  "org-wide",
  "team-scoped",
  "auto-sync-permissions",
]);
export type KnowledgeBaseVisibility = z.infer<
  typeof KnowledgeBaseVisibilitySchema
>;
