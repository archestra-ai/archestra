import { ConfluenceConnector } from "./confluence/confluence-connector";
import { JiraConnector } from "./jira/jira-connector";
import type { Connector } from "./types";

const connectorRegistry: Record<string, () => Connector> = {
  jira: () => new JiraConnector(),
  confluence: () => new ConfluenceConnector(),
};

export function getConnector(type: string): Connector {
  const factory = connectorRegistry[type];
  if (!factory) {
    throw new Error(`Unknown connector type: ${type}`);
  }
  return factory();
}
