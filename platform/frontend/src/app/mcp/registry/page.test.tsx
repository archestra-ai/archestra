import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getServerApiHeadersMock,
  searchMcpRegistryMock,
  getIssueIndexMock,
  getInternalMcpCatalogMock,
  getMcpServersMock,
} = vi.hoisted(() => ({
  getServerApiHeadersMock: vi.fn(),
  searchMcpRegistryMock: vi.fn(),
  getIssueIndexMock: vi.fn(),
  getInternalMcpCatalogMock: vi.fn(),
  getMcpServersMock: vi.fn(),
}));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      searchMcpRegistry: searchMcpRegistryMock,
      getMcpRegistryIssueIndex: getIssueIndexMock,
      getInternalMcpCatalog: getInternalMcpCatalogMock,
      getMcpServers: getMcpServersMock,
    },
  };
});

const { requestCookies, requestHeaders } = vi.hoisted(() => ({
  requestCookies: new Map<string, string>(),
  // A full page load, as the proxy marks it.
  requestHeaders: new Map<string, string>([
    ["x-archestra-shell-seed", "/mcp/registry"],
  ]),
}));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => requestHeaders.get(name) ?? null,
  }),
  cookies: async () => ({
    get: (name: string) =>
      requestCookies.has(name)
        ? { name, value: requestCookies.get(name) }
        : undefined,
  }),
}));

vi.mock("@/lib/utils/server", () => ({
  getServerApiHeaders: getServerApiHeadersMock,
}));

// The client page reads the seeded cache the way the page's hooks do: by key,
// with a query that would fetch (and fail the test) if nothing was seeded.
vi.mock("./page.client", () => ({
  default: function SeedProbe() {
    const page = useQuery({
      queryKey: ["mcp-registry", "page", expectedRequest.current, "all"],
      queryFn: () => {
        throw new Error("the page was not seeded");
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    const index = useQuery({
      queryKey: ["mcp-registry", "issue-index"],
      queryFn: () => {
        throw new Error("the index was not seeded");
      },
      staleTime: Number.POSITIVE_INFINITY,
    });
    return (
      <div data-testid="mcp-registry-page">
        {JSON.stringify({ page: page.data ?? null, index: index.data ?? null })}
      </div>
    );
  },
}));

const expectedRequest: { current: unknown } = { current: null };

import { registryPageRequestFromUrl } from "./_parts/registry-list-query";
import McpRegistryPage from "./page";

const pageResponse = {
  data: [{ id: "cat-a", name: "a" }],
  pagination: { total: 1 },
  selectableTotal: 0,
  installs: [],
  attentionTiers: [[], []],
};
const indexResponse = { catalogItems: [{ id: "cat-a" }], servers: [] };

async function renderPage(searchParams: Record<string, string> = {}) {
  expectedRequest.current = registryPageRequestFromUrl(
    new URLSearchParams(searchParams),
  );
  const ui = await McpRegistryPage({
    searchParams: Promise.resolve(searchParams),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
  const rendered = JSON.parse(
    (await screen.findByTestId("mcp-registry-page")).textContent ?? "{}",
  );
  return { ...view, rendered };
}

describe("McpRegistryPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerApiHeadersMock.mockResolvedValue({ Cookie: "session=1" });
    searchMcpRegistryMock.mockResolvedValue({ data: pageResponse });
    getIssueIndexMock.mockResolvedValue({ data: indexResponse });
  });

  it("server-renders the first page into the page's cache", async () => {
    const { rendered, container } = await renderPage();

    expect(rendered.page).toEqual(pageResponse);
    // The issue index comes with the signed-in shell, not with the page.
    expect(getIssueIndexMock).not.toHaveBeenCalled();
    expect(searchMcpRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { Cookie: "session=1" },
        body: registryPageRequestFromUrl(new URLSearchParams()),
      }),
    );
    // The route skips its own early requests when the HTML carries the seed.
    expect(
      container.querySelector("[data-mcp-registry-seeded]"),
    ).not.toBeNull();
  });

  it("never loads the full catalog or install lists", async () => {
    await renderPage();

    expect(getInternalMcpCatalogMock).not.toHaveBeenCalled();
    expect(getMcpServersMock).not.toHaveBeenCalled();
  });

  it("asks for the page, filters and order the URL names", async () => {
    const url = {
      search: "git",
      status: "installed",
      sortBy: "name",
      sortDirection: "desc",
      page: "2",
      pageSize: "20",
    };

    const { rendered } = await renderPage(url);

    expect(searchMcpRegistryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          search: "git",
          installState: "installed",
          sortBy: "name",
          sortDirection: "desc",
          limit: 20,
          offset: 20,
        }),
      }),
    );
    expect(rendered.page).toEqual(pageResponse);
  });

  it("leaves a page that maps names through browser data to the browser", async () => {
    const { rendered, container } = await renderPage({ author: "Alex" });

    expect(searchMcpRegistryMock).not.toHaveBeenCalled();
    expect(rendered.page).toBeNull();
    // A full page load whose page was not seeded: only the shell's index.
    expect(
      container
        .querySelector("[data-mcp-registry-seeded]")
        ?.getAttribute("data-mcp-registry-seeded"),
    ).toBe("index");
  });

  it("renders the page unseeded when the backend cannot answer", async () => {
    searchMcpRegistryMock.mockRejectedValue(new Error("down"));
    getIssueIndexMock.mockRejectedValue(new Error("down"));
    expectedRequest.current = registryPageRequestFromUrl(new URLSearchParams());

    const ui = await McpRegistryPage({ searchParams: Promise.resolve({}) });
    const { container } = render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        {ui}
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId("mcp-registry-page")).toBeTruthy();
    // A full page load whose page was not seeded: only the shell's index.
    expect(
      container
        .querySelector("[data-mcp-registry-seeded]")
        ?.getAttribute("data-mcp-registry-seeded"),
    ).toBe("index");
  });

  it("leaves a client-side navigation or route prefetch to the link's own prefetch", async () => {
    requestHeaders.delete("x-archestra-shell-seed");
    try {
      const { rendered, container } = await renderPage();

      expect(searchMcpRegistryMock).not.toHaveBeenCalled();
      expect(rendered.page).toBeNull();
      expect(container.querySelector("[data-mcp-registry-seeded]")).toBeNull();
    } finally {
      requestHeaders.set("x-archestra-shell-seed", "/mcp/registry");
    }
  });

  it("renders the page unseeded when the backend does not answer in time", async () => {
    vi.useFakeTimers();
    try {
      searchMcpRegistryMock.mockReturnValue(new Promise(() => {}));
      const ui = McpRegistryPage({ searchParams: Promise.resolve({}) });
      await vi.advanceTimersByTimeAsync(2_000);
      await ui;
    } finally {
      vi.useRealTimers();
    }
    expect(searchMcpRegistryMock).toHaveBeenCalledTimes(1);
  });
});
