import type { KnowledgeConnectorConfig } from "../../types/knowledge-connector";
import type { KnowledgeConnector, KnowledgeDocument, SyncResult } from "../../types/knowledge-connector";
import { NotionConnector } from "./notion/notion-connector";

// ---------------------------------------------------------------------------
// Registry — maps connector type → factory
// ---------------------------------------------------------------------------

export function createConnector(
  config: KnowledgeConnectorConfig
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): KnowledgeConnector<any, any> {
  switch (config.type) {
    case "jira":
      // Dynamically imported to keep bundle sizes reasonable
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return new (require("./jira/jira-connector").JiraConnector)(config);
    case "confluence":
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return new (require("./confluence/confluence-connector").ConfluenceConnector)(config);
    case "github":
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return new (require("./github/github-connector").GitHubConnector)(config);
    case "gitlab":
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return new (require("./gitlab/gitlab-connector").GitLabConnector)(config);
    case "servicenow":
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return new (require("./servicenow/servicenow-connector").ServiceNowConnector)(config);
    case "notion":
      return new NotionConnector(config);
    default: {
      const _exhaustive: never = config;
      throw new Error(`Unknown connector type: ${(_exhaustive as KnowledgeConnectorConfig).type}`);
    }
  }
}

export type { KnowledgeConnector, KnowledgeDocument, SyncResult };
