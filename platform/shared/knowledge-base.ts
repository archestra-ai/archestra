/**
 * Shared knowledge-base constants used by both frontend and backend.
 */

export const KNOWLEDGE_CONNECTOR_LABELS: Record<string, string> = {
  jira: "Jira",
  confluence: "Confluence",
  github: "GitHub",
  gitlab: "GitLab",
  servicenow: "ServiceNow",
  notion: "Notion",
};

export type KnowledgeConnectorType = keyof typeof KNOWLEDGE_CONNECTOR_LABELS;
