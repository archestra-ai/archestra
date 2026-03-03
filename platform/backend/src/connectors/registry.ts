import type {
  Connector,
  ConnectorType,
} from "@/types/knowledge-connectors/connector";
import { ConfluenceConnector } from "./confluence/confluence-connector";
import { JiraConnector } from "./jira/jira-connector";

const connectorRegistry: Record<ConnectorType, () => Connector> = {
  jira: () => new JiraConnector(),
  confluence: () => new ConfluenceConnector(),
};

export function getConnector(type: string): Connector {
  const factory = connectorRegistry[type as ConnectorType];
  if (!factory) {
    throw new Error(`Unknown connector type: ${type}`);
  }
  return factory();
}
