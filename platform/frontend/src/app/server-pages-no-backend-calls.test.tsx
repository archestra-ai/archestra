import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatPageServer from "@/app/llm/logs/[id]/page";
import McpGatewaysPageServer from "@/app/mcp/gateways/page";
import McpToolCallDetailPageServer from "@/app/mcp/logs/[id]/page";
import McpGatewayLogsPageServer from "@/app/mcp/logs/page";
import McpRegistryPage from "@/app/mcp/registry/page";
import { SHELL_SEED_HEADER } from "@/lib/auth/shell-seed";

// A navigation to these pages used to wait for the server render to call the
// backend (permissions, lists, a detail record) for data the browser already
// caches and checks. Every SDK operation is recorded here; none may run.
const { sdkCalls, getServerApiHeaders, requestHeaders } = vi.hoisted(() => ({
  sdkCalls: [] as string[],
  getServerApiHeaders: vi.fn(),
  requestHeaders: { current: new Headers() },
}));

vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: new Proxy(
      {},
      {
        get: (_target, operation) => () => {
          sdkCalls.push(String(operation));
          return Promise.resolve({ data: undefined });
        },
      },
    ),
  };
});
vi.mock("@/lib/utils/server", () => ({ getServerApiHeaders }));
// The registry renders its first rows on the server only for a document load
// the proxy marks; every other request reaches it without the marker.
vi.mock("next/headers", () => ({
  headers: async () => requestHeaders.current,
  cookies: async () => ({ get: () => undefined }),
}));

vi.mock("@/app/mcp/gateways/page.client", () => ({ default: () => <main /> }));
vi.mock("@/app/mcp/registry/page.client", () => ({ default: () => <main /> }));
vi.mock("@/app/mcp/logs/page.client", () => ({ default: () => <main /> }));
vi.mock("@/app/mcp/logs/[id]/page.client", () => ({
  McpToolCallDetailPage: () => <main />,
}));
vi.mock("@/app/llm/logs/[id]/page.client", () => ({
  default: () => <main />,
}));

const params = { params: Promise.resolve({ id: "record-1" }) };
const registrySearchParams = { searchParams: Promise.resolve({}) };

// The registry hydrates the query cache it seeds, as the app's provider would.
const renderPage = (ui: ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

describe("server pages that read the client cache", () => {
  beforeEach(() => {
    sdkCalls.length = 0;
    getServerApiHeaders.mockClear();
    requestHeaders.current = new Headers();
  });

  it.each<[string, () => Promise<ReactElement> | ReactElement]>([
    ["/mcp/gateways", McpGatewaysPageServer],
    ["/mcp/registry", () => McpRegistryPage(registrySearchParams)],
    ["/mcp/logs", McpGatewayLogsPageServer],
    ["/mcp/logs/[id]", () => McpToolCallDetailPageServer(params)],
    ["/llm/logs/[id]", () => ChatPageServer(params)],
  ])("%s renders without calling the backend", async (_path, page) => {
    renderPage(await page());

    expect(sdkCalls).toEqual([]);
    expect(getServerApiHeaders).not.toHaveBeenCalled();
  });

  // A full page load of the registry is the one exception: the proxy marks
  // it, and the page reads only its first page, for rows in the HTML.
  it("/mcp/registry reads only its first page on a marked document load", async () => {
    requestHeaders.current = new Headers({
      [SHELL_SEED_HEADER]: "/mcp/registry",
    });

    renderPage(await McpRegistryPage(registrySearchParams));

    expect(sdkCalls).toEqual(["searchMcpRegistry"]);
  });
});
