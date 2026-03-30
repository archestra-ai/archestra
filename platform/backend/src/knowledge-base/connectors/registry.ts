import { NotionConnector } from "./notion/notion-connector";

// ---------------------------------------------------------------------------
// Connector registry — maps connector type strings to connector instances.
// New connectors must be registered here so the knowledge-base service can
// look them up by type at runtime.
// ---------------------------------------------------------------------------

export type ConnectorType =
  | "jira"
  | "confluence"
  | "github"
  | "gitlab"
  | "servicenow"
  | "notion";

// Each connector must expose at least these three methods
export interface IKnowledgeConnector {
  validateConfig(config: unknown): { valid: boolean; error?: string };
  testConnection(config: unknown): Promise<{ success: boolean; error?: string }>;
  sync(
    config: unknown,
    checkpoint?: unknown
  ): Promise<{
    documents: Array<{
      id: string;
      title: string;
      content: string;
      url?: string;
      createdAt?: string;
      updatedAt?: string;
      metadata?: Record<string, unknown>;
    }>;
    errors: string[];
    checkpoint?: unknown;
  }>;
}

const registry = new Map<ConnectorType, IKnowledgeConnector>();

// ---------------------------------------------------------------------------
// Register built-in connectors
// ---------------------------------------------------------------------------

registry.set("notion", new NotionConnector());

// Jira, Confluence, GitHub, GitLab, ServiceNow connectors should be
// registered here as they are implemented, e.g.:
//
//   import { JiraConnector } from "./jira/jira-connector";
//   registry.set("jira", new JiraConnector());
//
// They are omitted here to avoid circular-dependency issues when those files
// don't yet exist in the repository.

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve a connector by its type string.
 * Throws if the type is not registered.
 */
export function getConnector(type: ConnectorType): IKnowledgeConnector {
  const connector = registry.get(type);
  if (!connector) {
    throw new Error(
      `No knowledge connector registered for type "${type}". ` +
        `Available types: ${[...registry.keys()].join(", ")}`
    );
  }
  return connector;
}

/**
 * Return the list of all registered connector types.
 */
export function getRegisteredConnectorTypes(): ConnectorType[] {
  return [...registry.keys()];
}

export default registry;
