import type { Connector, ConnectorType } from "@/types";
import { AsanaConnector } from "./asana/asana-connector";
import { ConfluenceConnector } from "./confluence/confluence-connector";
import { DropboxConnector } from "./dropbox/dropbox-connector";
import { GoogleDriveConnector } from "./gdrive/gdrive-connector";
import { GithubConnector } from "./github/github-connector";
import { GitlabConnector } from "./gitlab/gitlab-connector";
import { JiraConnector } from "./jira/jira-connector";
import { LinearConnector } from "./linear/linear-connector";
import { NotionConnector } from "./notion/notion-connector";
import { OneDriveConnector } from "./onedrive/onedrive-connector";
import { OutlineConnector } from "./outline/outline-connector";
import { SalesforceConnector } from "./salesforce/salesforce-connector";
import { ServiceNowConnector } from "./servicenow/servicenow-connector";
import { SharePointConnector } from "./sharepoint/sharepoint-connector";

const connectorRegistry: Record<ConnectorType, () => Connector> = {
  jira: () => new JiraConnector(),
  confluence: () => new ConfluenceConnector(),
  github: () => new GithubConnector(),
  gitlab: () => new GitlabConnector(),
  servicenow: () => new ServiceNowConnector(),
  notion: () => new NotionConnector(),
  sharepoint: () => new SharePointConnector(),
  gdrive: () => new GoogleDriveConnector(),
  dropbox: () => new DropboxConnector(),
  onedrive: () => new OneDriveConnector(),
  outline: () => new OutlineConnector(),
  asana: () => new AsanaConnector(),
  linear: () => new LinearConnector(),
  salesforce: () => new SalesforceConnector(),
};

export function getConnector(type: string): Connector {
  const factory = connectorRegistry[type as ConnectorType];
  if (!factory) {
    throw new Error(`Unknown connector type: ${type}`);
  }
  return factory();
}
