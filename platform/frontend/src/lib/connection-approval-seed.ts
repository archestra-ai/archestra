import type { archestraApiTypes } from "@archestra/shared";
import {
  agentOptionsByIdsQueryKey,
  agentOptionsPageQueryKey,
  clientConnectionQueryKey,
  defaultMcpGatewayQueryKey,
  llmProxyQueryKey,
  pluginsQueryKey,
  skillNamesQueryKey,
} from "@/lib/connection-approval-query-keys";
import { llmModelsQueryKey } from "@/lib/llm-models-query-keys";
import { availableLlmProviderApiKeysQueryKey } from "@/lib/llm-provider-api-keys-query-keys";

/** The gateways the approval page offers: gateways and legacy profiles, not other members' personal ones. */
export const CONNECTION_GATEWAY_FILTERS = {
  agentTypes: ["profile", "mcp_gateway"] as ("profile" | "mcp_gateway")[],
  excludeOtherPersonalAgents: true,
};

/** How many gateways the approval page lists before the user searches. */
export const CONNECTION_GATEWAY_PAGE_SIZE = 20;

/** The query `useAgentOptionsPage` sends for the approval page's gateway list. */
export const CONNECTION_GATEWAY_PAGE_QUERY = {
  excludeBuiltIn: true,
  ...CONNECTION_GATEWAY_FILTERS,
  limit: CONNECTION_GATEWAY_PAGE_SIZE,
};

/** The filters of the approval page's lookup of the gateways it names by id. */
export const CONNECTION_GATEWAY_REFERENCE_FILTERS = {
  ...CONNECTION_GATEWAY_FILTERS,
  excludeBuiltIn: true,
};

/**
 * The parts of a connection approval document the server reads, each the
 * response of its own endpoint. A part the viewer may not read, or that the
 * page does not show, is left out and its query loads in the browser.
 */
export type ConnectionApprovalSeed = {
  connectRequest: string;
  /** `GET /api/client-connections/:id` */
  request?: archestraApiTypes.GetClientConnectionResponses["200"];
  /** `GET /api/mcp-gateways/default?includeTools=false` */
  defaultGateway?:
    | archestraApiTypes.GetDefaultMcpGatewayResponses["200"]
    | null;
  /** `GET /api/agents/options/page` with the approval page's gateway query */
  gatewayPage?: archestraApiTypes.GetAgentOptionsPageResponses["200"];
  /** `GET /api/agents/options?ids=` for the gateways the page names by id */
  gatewayReferences?: {
    ids: string[];
    options: archestraApiTypes.GetAgentOptionsResponses["200"]["data"];
  };
  /** `GET /api/llm-proxy` */
  llmProxy?: archestraApiTypes.GetLlmProxyResponses["200"] | null;
  /** `GET /api/skills/names` */
  skillNames?: archestraApiTypes.GetSkillNamesResponses["200"];
  /** `GET /api/plugins` */
  plugins?: archestraApiTypes.GetPluginsResponses["200"];
  /** `GET /api/llm-provider-api-keys/available` */
  availableApiKeys?: archestraApiTypes.GetAvailableLlmProviderApiKeysResponses["200"];
  /** `GET /api/llm-models/available` */
  models?: archestraApiTypes.GetLlmModelsResponses["200"];
};

/**
 * The approval page's queries, filled from the parts the server read for this
 * document. With these in the cache the page renders its final state on the
 * server and on the first browser render, and none of its queries asks again
 * while the data is fresh. Each later fetch is a refresh from its own endpoint.
 */
export function connectionApprovalSeedQueries(
  seed: ConnectionApprovalSeed,
): Array<{ queryKey: readonly unknown[]; data: unknown }> {
  const queries: Array<{ queryKey: readonly unknown[]; data: unknown }> = [];
  const add = (queryKey: readonly unknown[], data: unknown) => {
    if (data !== undefined) queries.push({ queryKey, data });
  };
  add(clientConnectionQueryKey(seed.connectRequest), seed.request);
  add(defaultMcpGatewayQueryKey, seed.defaultGateway);
  if (seed.gatewayPage) {
    // An infinite query's cache entry: its pages and their cursors.
    add(agentOptionsPageQueryKey(CONNECTION_GATEWAY_PAGE_QUERY), {
      pages: [seed.gatewayPage],
      pageParams: [undefined],
    });
  }
  if (seed.gatewayReferences) {
    add(
      agentOptionsByIdsQueryKey(
        seed.gatewayReferences.ids,
        CONNECTION_GATEWAY_REFERENCE_FILTERS,
      ),
      seed.gatewayReferences.options,
    );
  }
  add(llmProxyQueryKey, seed.llmProxy);
  add(skillNamesQueryKey, seed.skillNames);
  add(pluginsQueryKey({}), seed.plugins);
  add(
    availableLlmProviderApiKeysQueryKey(undefined, undefined),
    seed.availableApiKeys,
  );
  add(llmModelsQueryKey(null), seed.models);
  return queries;
}
