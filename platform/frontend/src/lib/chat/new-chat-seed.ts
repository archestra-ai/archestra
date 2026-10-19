import {
  type archestraApiTypes,
  PLAYWRIGHT_MCP_CATALOG_ID,
} from "@archestra/shared";

type NewChatBootstrap = archestraApiTypes.GetNewChatBootstrapResponses["200"];

/**
 * The new-chat composer's queries, filled from one `/api/bootstrap/new-chat`
 * read: the agent roster, the provider keys, the model catalog, and the
 * starting agent's detail, sub-agents, credential readiness, browser tools,
 * default prompts and its key's models, and the models of the member's saved
 * default key. With these in the cache the composer
 * renders ready, and none of its queries asks again while the data is fresh.
 * Each later fetch of these queries is a refresh and goes to its own endpoint.
 *
 * The keys are spelled out rather than imported, as `applyBootstrap` does:
 * the server seed imports this module, and the modules that own the keys are
 * client modules. A test pins each key to the query that reads it.
 */
export function newChatSeedQueries(
  data: NewChatBootstrap,
): Array<{ queryKey: readonly unknown[]; data: unknown }> {
  const queries: Array<{ queryKey: readonly unknown[]; data: unknown }> = [
    {
      queryKey: ["agents", "chat-roster", "bootstrap", "v3"],
      data: data.roster,
    },
    {
      queryKey: ["llm-provider-api-keys", undefined, undefined],
      data: data.apiKeys,
    },
    { queryKey: ["llm-models", null], data: data.models },
  ];
  if (data.availableApiKeys) {
    queries.push({
      queryKey: ["available-llm-provider-api-keys", undefined, undefined],
      data: data.availableApiKeys,
    });
  }
  if (data.memberDefaultKeyModels) {
    queries.push({
      queryKey: ["llm-models", data.memberDefaultKeyModels.apiKeyId],
      data: data.memberDefaultKeyModels.models,
    });
  }
  const agent = data.agent;
  if (!agent) return queries;
  queries.push(
    { queryKey: ["agents", agent.id], data: agent.detail },
    { queryKey: ["agent-delegations", agent.id], data: agent.delegations },
    {
      queryKey: ["agents", "credential-readiness", [agent.id]],
      data: agent.credentialReadiness,
    },
    {
      queryKey: [
        "agents",
        agent.id,
        "tools",
        "catalog",
        PLAYWRIGHT_MCP_CATALOG_ID,
      ],
      data: agent.browserTools,
    },
  );
  if (agent.defaultSuggestedPrompts) {
    queries.push({
      queryKey: ["agents", agent.id, "default-suggested-prompts"],
      data: agent.defaultSuggestedPrompts,
    });
  }
  if (agent.keyModels && agent.detail.llmApiKeyId) {
    queries.push({
      queryKey: ["llm-models", agent.detail.llmApiKeyId],
      data: agent.keyModels,
    });
  }
  return queries;
}
