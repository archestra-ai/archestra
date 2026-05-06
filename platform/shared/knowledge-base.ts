import { z } from "zod";

export const EmbeddingModelSchema = z.string().min(1);
export type EmbeddingModel = string;

/** Maximum number of chunks to embed per embedding API call */
export const EMBEDDING_BATCH_SIZE = 100;

/**
 * Supported embedding column sizes. Each entry maps to a dedicated
 * `vector(N)` column and HNSW index in the `kb_chunks` table.
 */
export const EmbeddingDimensionsSchema = z.union([
  z.literal(3072),
  z.literal(1536),
  z.literal(768),
]);
export type SupportedEmbeddingDimension = z.infer<
  typeof EmbeddingDimensionsSchema
>;
export const SUPPORTED_EMBEDDING_DIMENSIONS = [3072, 1536, 768] as const;

/**
 * Maps a dimension size to its database column name.
 * - 1536 → "embedding" (original column, kept for backward compatibility)
 * - 768  → "embedding_768"
 */
export function getEmbeddingColumnName(dimensions: number): string {
  if (dimensions === 1536) return "embedding";
  return `embedding_${dimensions}`;
}

/**
 * Display labels for connector types.
 * Used in UI placeholders and titles.
 */
export const CONNECTOR_TYPE_LABELS = {
  jira: "Jira",
  confluence: "Confluence",
  github: "GitHub",
  gitlab: "GitLab",
  notion: "Notion",
  servicenow: "ServiceNow",
  sharepoint: "SharePoint",
  gdrive: "Google Drive",
  file_upload: "File Upload",
  dropbox: "Dropbox",
  onedrive: "OneDrive",
  asana: "Asana",
  linear: "Linear",
  outline: "Outline",
  salesforce: "Salesforce",
} as const;

export type ConnectorType = keyof typeof CONNECTOR_TYPE_LABELS;

const CONNECTOR_PLACEHOLDER_DEPARTMENTS = [
  "Engineering",
  "Finance",
  "Marketing",
  "Sales",
  "Product",
  "Design",
  "Operations",
  "Support",
];

/**
 * Generate a placeholder connector name like "Marketing Confluence Connector".
 * Picks a random department each call.
 */
export function getConnectorNamePlaceholder(
  connectorType: ConnectorType,
): string {
  const department =
    CONNECTOR_PLACEHOLDER_DEPARTMENTS[
      Math.floor(Math.random() * CONNECTOR_PLACEHOLDER_DEPARTMENTS.length)
    ];
  const label = CONNECTOR_TYPE_LABELS[connectorType] ?? connectorType;
  return `${department} ${label} Connector`;
}

/** Minimum relevance score (0-10) for reranked chunks to be included in results */
export const RERANKER_MIN_RELEVANCE_SCORE = 3;

/**
 * Nomic embedding models require task instruction prefixes in the input text.
 * Documents should use "search_document: " and queries should use "search_query: ".
 * See: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
 */
type NomicTaskType = "search_document" | "search_query";

export function isNomicModel(model: string): boolean {
  return model.startsWith("nomic") || model.includes("/nomic-embed-text");
}

/**
 * Add the appropriate Nomic task prefix to embedding input text.
 * For non-Nomic models, returns the text unchanged.
 */
export function addNomicTaskPrefix(
  model: string,
  text: string,
  taskType: NomicTaskType,
): string {
  if (!isNomicModel(model)) return text;
  return `${taskType}: ${text}`;
}
