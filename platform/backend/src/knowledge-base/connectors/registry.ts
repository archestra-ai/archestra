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
import { PerforceConnector } from "./perforce/perforce-connector";
import { SalesforceConnector } from "./salesforce/salesforce-connector";
import { ServiceNowConnector } from "./servicenow/servicenow-connector";
import { SharePointConnector } from "./sharepoint/sharepoint-connector";
import { WebCrawlerConnector } from "./web-crawler/web-crawler-connector";

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
  web_crawler: () => new WebCrawlerConnector(),
  perforce: () => new PerforceConnector(),
};

export function getConnector(type: string): Connector {
  const factory = connectorRegistry[type as ConnectorType];
  if (!factory) {
    throw new Error(`Unknown connector type: ${type}`);
  }
  return factory();
}

/**
 * The connector types that implement permission sync, so the scheduler can ask
 * the database for exactly the connectors it could schedule instead of loading
 * the fleet and filtering in memory. Memoized: the answer is a property of the
 * registry, and the due-loop asks on every tick.
 */
export function getPermissionSyncConnectorTypes(): ConnectorType[] {
  if (permissionSyncConnectorTypes === null) {
    permissionSyncConnectorTypes = (
      Object.keys(connectorRegistry) as ConnectorType[]
    ).filter((type) => connectorRegistry[type]().supportsPermissionSync);
  }
  return permissionSyncConnectorTypes;
}

let permissionSyncConnectorTypes: ConnectorType[] | null = null;
