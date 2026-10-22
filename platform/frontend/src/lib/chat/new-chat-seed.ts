import {
  type archestraApiTypes,
  PLAYWRIGHT_MCP_CATALOG_ID,
} from "@archestra/shared";
import {
  agentCatalogToolsQueryKey,
  agentCredentialReadinessQueryKey,
  agentDefaultSuggestedPromptsQueryKey,
  agentQueryKey,
  chatAgentsQueryKey,
} from "@/lib/agent-query-keys";
import { agentDelegationsQueryKeys } from "@/lib/agent-tools-query-keys";
import { llmModelsQueryKey } from "@/lib/llm-models-query-keys";
import {
  availableLlmProviderApiKeysQueryKey,
  llmProviderApiKeysQueryKey,
} from "@/lib/llm-provider-api-keys-query-keys";

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
 * The keys come from the React-free key modules the hooks themselves use, so
 * a renamed key cannot leave the seed writing a stale one; a test still pins
 * each key to the query that reads it.
 */
export function newChatSeedQueries(
  data: NewChatBootstrap,
): Array<{ queryKey: readonly unknown[]; data: unknown }> {
  const queries: Array<{ queryKey: readonly unknown[]; data: unknown }> = [
    { queryKey: chatAgentsQueryKey, data: data.roster },
    {
      queryKey: llmProviderApiKeysQueryKey(undefined, undefined),
      data: data.apiKeys,
    },
    { queryKey: llmModelsQueryKey(null), data: data.models },
  ];
  if (data.availableApiKeys) {
    queries.push({
      queryKey: availableLlmProviderApiKeysQueryKey(undefined, undefined),
      data: data.availableApiKeys,
    });
  }
  const agent = data.agent;
  if (!agent) return queries;
  queries.push(
    { queryKey: agentQueryKey(agent.id), data: agent.detail },
    {
      queryKey: agentDelegationsQueryKeys.byAgent(agent.id),
      data: agent.delegations,
    },
    {
      queryKey: agentCredentialReadinessQueryKey([agent.id]),
      data: agent.credentialReadiness,
    },
    {
      queryKey: agentCatalogToolsQueryKey(agent.id, PLAYWRIGHT_MCP_CATALOG_ID),
      data: agent.browserTools,
    },
  );
  if (agent.defaultSuggestedPrompts) {
    queries.push({
      queryKey: agentDefaultSuggestedPromptsQueryKey(agent.id),
      data: agent.defaultSuggestedPrompts,
    });
  }
  if (agent.keyModels && agent.detail.llmApiKeyId) {
    queries.push({
      queryKey: llmModelsQueryKey(agent.detail.llmApiKeyId),
      data: agent.keyModels,
    });
  }
  return queries;
}
