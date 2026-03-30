/**
 * Shared knowledge-base constants used by both the frontend and backend.
 * Exported from the shared package so both sides stay in sync.
 */

// ---------------------------------------------------------------------------
// Connector type → human-readable label map
// ---------------------------------------------------------------------------

export const KNOWLEDGE_CONNECTOR_LABELS: Record<string, string> = {
  jira: "Jira",
  confluence: "Confluence",
  github: "GitHub",
  gitlab: "GitLab",
  servicenow: "ServiceNow",
  notion: "Notion",
} as const;

export type KnowledgeConnectorType = keyof typeof KNOWLEDGE_CONNECTOR_LABELS;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Returns the human-readable label for a connector type.
 * Falls back to the raw type string if not found.
 */
export function getConnectorLabel(type: string): string {
  return KNOWLEDGE_CONNECTOR_LABELS[type] ?? type;
}
