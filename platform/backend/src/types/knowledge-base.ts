import { z } from "zod";

/**
 * Knowledge base provider types.
 * @deprecated The provider column is being phased out. All knowledge bases
 * now use the built-in pgvector RAG stack. Kept for DB schema compatibility.
 */
export const KnowledgeBaseProviderTypeSchema = z.enum(["lightrag"]);
export type KnowledgeBaseProviderType = z.infer<
  typeof KnowledgeBaseProviderTypeSchema
>;

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

/**
 * LightRAG provider configuration stored in the knowledge_bases.config column.
 * @deprecated Being phased out — kept for DB schema compatibility.
 */
export const LightragConfigSchema = z.object({
  apiUrl: z.string(),
  apiKey: z.string().optional(),
});
export type LightragConfig = z.infer<typeof LightragConfigSchema>;
