import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ChatPageServer from "@/app/llm/logs/[id]/page";
import McpGatewaysPageServer from "@/app/mcp/gateways/page";
import McpToolCallDetailPageServer from "@/app/mcp/logs/[id]/page";
import McpGatewayLogsPageServer from "@/app/mcp/logs/page";
import McpRegistryPage from "@/app/mcp/registry/page";

// A navigation to these pages used to wait for the server render to call the
// backend (permissions, lists, a detail record) for data the browser already
// caches and checks. Every SDK operation is recorded here; none may run.
const { sdkCalls, getServerApiHeaders } = vi.hoisted(() => ({
  sdkCalls: [] as string[],
  getServerApiHeaders: vi.fn(),
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

describe("server pages that read the client cache", () => {
  beforeEach(() => {
    sdkCalls.length = 0;
    getServerApiHeaders.mockClear();
  });

  it.each<[string, () => Promise<ReactElement> | ReactElement]>([
    ["/mcp/gateways", McpGatewaysPageServer],
    ["/mcp/registry", McpRegistryPage],
    ["/mcp/logs", McpGatewayLogsPageServer],
    ["/mcp/logs/[id]", () => McpToolCallDetailPageServer(params)],
    ["/llm/logs/[id]", () => ChatPageServer(params)],
  ])("%s renders without calling the backend", async (_path, page) => {
    render(await page());

    expect(sdkCalls).toEqual([]);
    expect(getServerApiHeaders).not.toHaveBeenCalled();
  });
});
