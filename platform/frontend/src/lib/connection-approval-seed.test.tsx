import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDefaultMcpGateway } from "@/lib/agent.query";
import {
  useAgentOptionsByIds,
  useAgentOptionsPage,
} from "@/lib/agent-options.query";
import { useClientConnection } from "@/lib/client-connection.query";
import {
  CONNECTION_GATEWAY_FILTERS,
  CONNECTION_GATEWAY_PAGE_SIZE,
  CONNECTION_GATEWAY_REFERENCE_FILTERS,
  type ConnectionApprovalSeed,
  connectionApprovalSeedQueries,
} from "@/lib/connection-approval-seed";
import { useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import { usePlugins } from "@/lib/plugins/plugin.query";
import { useSkillNames } from "@/lib/skills/skill.query";

const REQUEST_ID = "a".repeat(48);
const ADMIN_GATEWAY = "11111111-1111-4111-8111-111111111111";
const DEFAULT_GATEWAY = "22222222-2222-4222-8222-222222222222";

// Distinct values per part, so a key that reads the wrong part fails too.
const seed = {
  connectRequest: REQUEST_ID,
  request: { clientId: "opencode", platform: "linux", userCode: "AAAA-AAAA" },
  defaultGateway: { id: DEFAULT_GATEWAY, name: "My Gateway" },
  gatewayPage: {
    data: [{ id: ADMIN_GATEWAY, name: "Shared" }],
    pagination: { nextCursor: "next" },
  },
  gatewayReferences: {
    ids: [ADMIN_GATEWAY, DEFAULT_GATEWAY],
    options: [{ id: DEFAULT_GATEWAY, name: "referenced" }],
  },
  llmProxy: { id: "proxy-1" },
  skillNames: { data: [{ id: "s1", name: "skill" }], total: 1 },
  plugins: [{ id: "plugin-1" }],
  availableApiKeys: [{ id: "key-1" }],
  models: [{ id: "model-1" }],
} as unknown as ConnectionApprovalSeed;

describe("connectionApprovalSeedQueries", () => {
  let client: QueryClient;
  const fetchMock = vi.fn();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    });
    for (const { queryKey, data } of connectionApprovalSeedQueries(seed)) {
      client.setQueryData(queryKey, data);
    }
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  // Each part lands under the key the approval page's own query reads (with
  // the arguments the page passes), so the page renders from it and sends no
  // request while it is fresh.
  it("fills each approval page query from its own part, with no request", () => {
    const parts = renderHook(
      () => ({
        request: useClientConnection(REQUEST_ID).data,
        defaultGateway: useDefaultMcpGateway().data,
        gatewayPage: useAgentOptionsPage({
          filters: CONNECTION_GATEWAY_FILTERS,
          limit: CONNECTION_GATEWAY_PAGE_SIZE,
        }).data?.pages[0],
        gatewayReferences: useAgentOptionsByIds({
          // In the page's order; the query sorts them.
          ids: [DEFAULT_GATEWAY, ADMIN_GATEWAY],
          filters: CONNECTION_GATEWAY_REFERENCE_FILTERS,
        }).data,
        llmProxy: useLlmProxy().data,
        skillNames: useSkillNames({ enabled: true }).data,
        plugins: usePlugins(true).data,
        availableApiKeys: useAvailableLlmProviderApiKeys().data,
        models: useLlmModels().data,
      }),
      { wrapper },
    ).result.current;

    expect(parts).toEqual({
      request: seed.request,
      defaultGateway: seed.defaultGateway,
      gatewayPage: seed.gatewayPage,
      gatewayReferences: seed.gatewayReferences?.options,
      llmProxy: seed.llmProxy,
      skillNames: seed.skillNames,
      plugins: seed.plugins,
      availableApiKeys: seed.availableApiKeys,
      models: seed.models,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("seeds only the parts the server read", () => {
    const keys = connectionApprovalSeedQueries({
      connectRequest: REQUEST_ID,
      request: seed.request,
    }).map(({ queryKey }) => queryKey);

    expect(keys).toEqual([["client-connection", REQUEST_ID]]);
  });
});
