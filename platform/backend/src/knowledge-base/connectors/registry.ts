import { KnowledgeConnectorConfig } from "../../types/knowledge-connector";
import { KnowledgeConnectorBase } from "./base-connector";
import { JiraConnector } from "./jira/jira-connector";
import { ConfluenceConnector } from "./confluence/confluence-connector";
import { GitHubConnector } from "./github/github-connector";
import { GitLabConnector } from "./gitlab/gitlab-connector";
import { ServiceNowConnector } from "./servicenow/servicenow-connector";
import { NotionConnector } from "./notion/notion-connector";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyConnector = KnowledgeConnectorBase<any, any>;

export function createConnector(
  config: KnowledgeConnectorConfig
): AnyConnector {
  switch (config.type) {
    case "jira":
      return new JiraConnector(config);
    case "confluence":
      return new ConfluenceConnector(config);
    case "github":
      return new GitHubConnector(config);
    case "gitlab":
      return new GitLabConnector(config);
    case "servicenow":
      return new ServiceNowConnector(config);
    case "notion":
      return new NotionConnector(config);
    default: {
      const _exhaustive: never = config;
      throw new Error(
        `Unknown connector type: ${(_exhaustive as KnowledgeConnectorConfig).type}`
      );
    }
  }
}
