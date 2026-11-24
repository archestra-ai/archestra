import type { archestraApiTypes } from "@archestra/shared";

export type McpToolCallRow =
  archestraApiTypes.GetMcpToolCallsResponses["200"]["data"][number];

/** An installed server's catalog name and icon, keyed by deployment name. */
export type McpServerDisplay = {
  name: string;
  icon: string | null;
  catalogId: string;
};

export type GatewayOption = Pick<
  archestraApiTypes.GetAgentOptionsResponses["200"]["data"][number],
  "id" | "name" | "agentType"
>;
