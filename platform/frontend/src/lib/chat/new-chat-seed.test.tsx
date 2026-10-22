import {
  type archestraApiTypes,
  PLAYWRIGHT_MCP_CATALOG_ID,
} from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAgentCredentialReadiness,
  useAgentDefaultSuggestedPrompts,
  useChatAgentBootstrap,
  useProfile,
} from "@/lib/agent.query";
import { useAgentDelegations } from "@/lib/agent-tools.query";
import { useHasPlaywrightMcpTools } from "@/lib/chat/chat.query";
import { newChatSeedQueries } from "@/lib/chat/new-chat-seed";
import { useLlmModels } from "@/lib/llm-models.query";
import {
  useAvailableLlmProviderApiKeys,
  useLlmProviderApiKeys,
} from "@/lib/llm-provider-api-keys.query";

type NewChatBootstrap = archestraApiTypes.GetNewChatBootstrapResponses["200"];

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";

// Distinct values per part, so a key that reads the wrong part fails too.
const bootstrap = {
  roster: [{ id: AGENT_ID, name: "Helper" }],
  apiKeys: [{ id: KEY_ID, name: "visible" }],
  availableApiKeys: [{ id: KEY_ID, name: "usable" }],
  models: [{ id: "all-models" }],
  agent: {
    id: AGENT_ID,
    detail: { id: AGENT_ID, name: "Helper", llmApiKeyId: KEY_ID },
    delegations: [{ id: "delegate" }],
    credentialReadiness: [{ agentId: AGENT_ID, missing: [] }],
    browserTools: [
      { id: "browser-tool", catalogId: PLAYWRIGHT_MCP_CATALOG_ID },
    ],
    defaultSuggestedPrompts: [{ summaryTitle: "Hi", prompt: "Say hi" }],
    keyModels: [{ id: "key-models" }],
  },
} as unknown as NewChatBootstrap;

describe("newChatSeedQueries", () => {
  let client: QueryClient;
  const fetchMock = vi.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    for (const { queryKey, data } of newChatSeedQueries(bootstrap)) {
      client.setQueryData(queryKey, data);
    }
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  // Each part lands under the key the composer's own query reads, so the
  // composer renders from it and sends no request while it is fresh.
  it("fills each composer query from its own part, with no request", () => {
    const parts = renderHook(
      () => ({
        roster: useChatAgentBootstrap().data,
        apiKeys: useLlmProviderApiKeys().data,
        availableApiKeys: useAvailableLlmProviderApiKeys().data,
        models: useLlmModels().data,
        detail: useProfile(AGENT_ID).data,
        delegations: useAgentDelegations(AGENT_ID).data,
        credentialReadiness: useAgentCredentialReadiness({ ids: [AGENT_ID] })
          .data,
        hasBrowserTools:
          useHasPlaywrightMcpTools(AGENT_ID).hasPlaywrightMcpTools,
        defaultSuggestedPrompts: useAgentDefaultSuggestedPrompts(AGENT_ID, {
          enabled: true,
        }).data,
        keyModels: useLlmModels({ apiKeyId: KEY_ID }).data,
      }),
      { wrapper },
    ).result.current;

    expect(parts).toEqual({
      roster: bootstrap.roster,
      apiKeys: bootstrap.apiKeys,
      availableApiKeys: bootstrap.availableApiKeys,
      models: bootstrap.models,
      detail: bootstrap.agent?.detail,
      delegations: bootstrap.agent?.delegations,
      credentialReadiness: bootstrap.agent?.credentialReadiness,
      hasBrowserTools: true,
      defaultSuggestedPrompts: bootstrap.agent?.defaultSuggestedPrompts,
      keyModels: bootstrap.agent?.keyModels,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("seeds only the shared parts when no agent can start the chat", () => {
    const keys = newChatSeedQueries({
      ...bootstrap,
      availableApiKeys: null,
      agent: null,
    }).map(({ queryKey }) => queryKey[0]);

    expect(keys).toEqual(["agents", "llm-provider-api-keys", "llm-models"]);
  });
});
