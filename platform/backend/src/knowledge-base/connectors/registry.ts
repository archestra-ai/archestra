import type {
  KnowledgeConnectorConfig,
  KnowledgeConnectorCheckpoint,
  KnowledgeConnectorSyncResult,
  JiraConfig,
  JiraCheckpoint,
  ConfluenceConfig,
  ConfluenceCheckpoint,
  GitHubConfig,
  GitHubCheckpoint,
  GitLabConfig,
  GitLabCheckpoint,
  ServiceNowConfig,
  ServiceNowCheckpoint,
  NotionConfig,
  NotionCheckpoint,
} from "../../types/knowledge-connector";
import { NotionConnector } from "./notion/notion-connector";

// ---------------------------------------------------------------------------
// Connector credential store type
// ---------------------------------------------------------------------------

export interface ConnectorCredentials {
  // Jira / Confluence
  username?: string;
  apiToken?: string;
  // GitHub / GitLab
  accessToken?: string;
  // ServiceNow
  password?: string;
  // Notion
  integrationToken?: string;
}

// ---------------------------------------------------------------------------
// Registry entry interface
// ---------------------------------------------------------------------------

export interface ConnectorRegistryEntry {
  validateConfig(config: KnowledgeConnectorConfig): Promise<void>;
  testConnection(
    config: KnowledgeConnectorConfig,
    credentials: ConnectorCredentials
  ): Promise<{ success: boolean; message: string }>;
  sync(
    config: KnowledgeConnectorConfig,
    credentials: ConnectorCredentials,
    checkpoint?: KnowledgeConnectorCheckpoint
  ): Promise<KnowledgeConnectorSyncResult>;
}

// ---------------------------------------------------------------------------
// Notion registry entry
// ---------------------------------------------------------------------------

const notionEntry: ConnectorRegistryEntry = {
  async validateConfig(config) {
    const notionConfig = config as NotionConfig;
    if (notionConfig.type !== "notion") throw new Error("Invalid connector type");
    const connector = new NotionConnector(notionConfig, "");
    await connector.validateConfig();
  },

  async testConnection(config, credentials) {
    const notionConfig = config as NotionConfig;
    const token = credentials.integrationToken ?? "";
    const connector = new NotionConnector(notionConfig, token);
    return connector.testConnection();
  },

  async sync(config, credentials, checkpoint) {
    const notionConfig = config as NotionConfig;
    const notionCheckpoint = checkpoint as NotionCheckpoint | undefined;
    const token = credentials.integrationToken ?? "";
    const connector = new NotionConnector(notionConfig, token);
    return connector.sync(notionCheckpoint);
  },
};

// ---------------------------------------------------------------------------
// Registry map
// ---------------------------------------------------------------------------

export const connectorRegistry: Record<string, ConnectorRegistryEntry> = {
  notion: notionEntry,
  // Additional connectors (jira, confluence, github, gitlab, servicenow)
  // should be registered here following the same pattern.
};

// ---------------------------------------------------------------------------
// Helper: resolve a connector entry by type
// ---------------------------------------------------------------------------

export function getConnectorEntry(type: string): ConnectorRegistryEntry {
  const entry = connectorRegistry[type];
  if (!entry) {
    throw new Error(
      `No connector registered for type "${type}". Available: ${Object.keys(connectorRegistry).join(", ")}`
    );
  }
  return entry;
}
