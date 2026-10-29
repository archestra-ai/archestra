import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { searchMcpRegistryMock, getIssueIndexMock } = vi.hoisted(() => ({
  searchMcpRegistryMock: vi.fn(),
  getIssueIndexMock: vi.fn(),
}));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      searchMcpRegistry: searchMcpRegistryMock,
      getMcpRegistryIssueIndex: getIssueIndexMock,
    },
  };
});

import { authQueryKeys } from "@/lib/auth/auth.query";
import { useMcpRegistryPage } from "@/lib/mcp/mcp-registry.query";
import { prefetchMcpRegistry } from "./prefetch-registry";
import { registryPageRequestFromUrl } from "./registry-list-query";

function signedInClient(permissions: Record<string, string[]>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
  });
  queryClient.setQueryData(authQueryKeys.session(), { user: { id: "u1" } });
  queryClient.setQueryData(authQueryKeys.userPermissions(), permissions);
  return queryClient;
}

describe("prefetchMcpRegistry", () => {
  beforeEach(() => {
    searchMcpRegistryMock.mockReset().mockResolvedValue({
      data: {
        data: [{ id: "cat-a" }],
        pagination: { total: 1 },
        selectableTotal: 0,
        installs: [],
      },
    });
    getIssueIndexMock
      .mockReset()
      .mockResolvedValue({ data: { catalogItems: [], servers: [] } });
  });

  it("warms the page the link asks for, so following it sends nothing", async () => {
    const queryClient = signedInClient({ mcpRegistry: ["read"] });

    await prefetchMcpRegistry(queryClient, "/mcp/registry");

    expect(searchMcpRegistryMock).toHaveBeenCalledWith({
      body: registryPageRequestFromUrl(new URLSearchParams()),
    });
    expect(getIssueIndexMock).toHaveBeenCalledTimes(1);

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const request = registryPageRequestFromUrl(new URLSearchParams());
    if (!request) throw new Error("the default URL builds a request");
    const { result } = renderHook(
      () => useMcpRegistryPage(request, { placeholderScope: "all" }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data?.data[0]?.id).toBe("cat-a"));
    expect(searchMcpRegistryMock).toHaveBeenCalledTimes(1);
  });

  it("follows the link's query", async () => {
    const queryClient = signedInClient({ mcpRegistry: ["read"] });

    await prefetchMcpRegistry(queryClient, "/mcp/registry?search=git");

    expect(searchMcpRegistryMock).toHaveBeenCalledWith({
      body: expect.objectContaining({ search: "git" }),
    });
  });

  it("does nothing for a reader who may not open the registry", async () => {
    const queryClient = signedInClient({ agent: ["read"] });

    await prefetchMcpRegistry(queryClient, "/mcp/registry");

    expect(searchMcpRegistryMock).not.toHaveBeenCalled();
    expect(getIssueIndexMock).not.toHaveBeenCalled();
  });
});
