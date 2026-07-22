import { z } from "zod";

export const EmbeddingModelSchema = z.string().min(1);
export type EmbeddingModel = string;

/** Maximum number of chunks to embed per embedding API call */
export const EMBEDDING_BATCH_SIZE = 100;

/**
 * Default cadence of the scheduled permission-sync pass for
 * `auto-sync-permissions` connectors: the next pass is due this many seconds
 * after the last one (manual, content-ingest-triggered, or scheduled) started.
 */
export const DEFAULT_PERMISSION_SYNC_INTERVAL_SECONDS = 30 * 60;

/**
 * Floor for the per-connector permission-sync interval. Also bounds how long
 * per-user group-membership lookups may be served from cache: a cached ACL
 * check is never staler than the shortest interval a connector can sync at.
 */
export const MIN_PERMISSION_SYNC_INTERVAL_SECONDS = 15 * 60;

/**
 * Ceiling for the per-connector permission-sync interval. Anything slower is
 * better expressed as follow-documents mode; without a ceiling, an
 * effectively-infinite interval would silently disable the scheduled pass
 * while looking configured.
 */
export const MAX_PERMISSION_SYNC_INTERVAL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Sentinel `permissionSyncIntervalSeconds` value: no interval-scheduled
 * passes — permissions follow the documents sync schedule instead. A pass
 * runs after every completed documents sync (permissions can change upstream
 * without any document changing) and on manual trigger. Stored as 0 so the
 * column stays NOT NULL.
 */
export const PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE = 0;

/**
 * Cadence of the FULL permission reconcile (the correctness backstop that
 * fail-closes vanished documents and containers). The user-facing frequency
 * setting drives cheap probe-driven DELTA passes; a pass is promoted to full
 * when the last full reconcile is older than this. Internal constant, not an
 * operator knob.
 */
export const PERMISSION_SYNC_FULL_RECONCILE_INTERVAL_SECONDS = 24 * 60 * 60;

export const SUPPORTED_EMBEDDING_DIMENSIONS = [
  3072, 1536, 1024, 768, 384,
] as const;
export type SupportedEmbeddingDimension =
  (typeof SUPPORTED_EMBEDDING_DIMENSIONS)[number];

/**
 * Supported embedding column sizes. Each entry maps to a dedicated
 * `vector(N)` column and HNSW index in the `kb_chunks` table.
 */
export const EmbeddingDimensionsSchema = z
  .number()
  .int()
  .refine(
    (value) =>
      SUPPORTED_EMBEDDING_DIMENSIONS.includes(
        value as SupportedEmbeddingDimension,
      ),
    {
      message: `Embedding dimensions must be one of: ${SUPPORTED_EMBEDDING_DIMENSIONS.join(", ")}`,
    },
  )
  .meta({
    id: "EmbeddingDimensions",
    enum: [...SUPPORTED_EMBEDDING_DIMENSIONS],
  });

/**
 * Use this alias where the backing storage or application contract is already
 * constrained to supported dimensions. The runtime schema object stays shared,
 * so OpenAPI still emits one reusable component.
 */
export const SupportedEmbeddingDimensionsSchema =
  EmbeddingDimensionsSchema as z.ZodType<SupportedEmbeddingDimension>;

/**
 * Maps a dimension size to its database column name.
 * - 1536 → "embedding" (original column, kept for backward compatibility)
 * - every other supported size → "embedding_<dimensions>" (e.g. "embedding_768")
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
  dropbox: "Dropbox",
  onedrive: "OneDrive",
  asana: "Asana",
  linear: "Linear",
  outline: "Outline",
  salesforce: "Salesforce",
  web_crawler: "Web Crawler",
  perforce: "Perforce (Helix Core)",
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
