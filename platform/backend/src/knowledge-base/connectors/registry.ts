import type { KnowledgeConnectorBase } from "../../types/knowledge-connector.js";
import { NotionConnector } from "./notion/notion-connector.js";

// Import other connectors here as they are added
// import { JiraConnector } from "./jira/jira-connector.js";
// import { ConfluenceConnector } from "./confluence/confluence-connector.js";
// import { GitHubConnector } from "./github/github-connector.js";
// import { GitLabConnector } from "./gitlab/gitlab-connector.js";
// import { ServiceNowConnector } from "./servicenow/servicenow-connector.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConnector = KnowledgeConnectorBase<any, any>;

const connectors: Record<string, AnyConnector> = {
  notion: new NotionConnector(),
  // jira: new JiraConnector(),
  // confluence: new ConfluenceConnector(),
  // github: new GitHubConnector(),
  // gitlab: new GitLabConnector(),
  // servicenow: new ServiceNowConnector(),
};

export function getConnector(type: string): AnyConnector {
  const connector = connectors[type];
  if (!connector) {
    throw new Error(`No knowledge connector registered for type: "${type}"`);
  }
  return connector;
}

export function listConnectorTypes(): string[] {
  return Object.keys(connectors);
}

export { connectors };
