import { z } from "zod";

/**
 * Object-level visibility for knowledge sources.
 */
export const KnowledgeSourceVisibilitySchema = z.enum([
  "org-wide",
  "team-scoped",
]);
export type KnowledgeSourceVisibility = z.infer<
  typeof KnowledgeSourceVisibilitySchema
>;
