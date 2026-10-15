import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { useAgentOptions, useProfiles } from "@/lib/agent.query";
import { useGatewayToolPreview } from "@/lib/mcp/gateway-tool-preview.query";
import { fetchAllSkills } from "@/lib/skills/skill.query";
import { useGatewayServers } from "./use-gateway-servers";

const origin = "http://localhost:9000";
const server = setupServer();
beforeAll(() => {
  archestraApiClient.setConfig({ baseUrl: origin });
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});

it("loads complete skill metadata without requesting manifest bodies on any page", async () => {
  const offsets: number[] = [];
  server.use(
    http.get(`${origin}/api/skills`, ({ request }) => {
      const params = new URL(request.url).searchParams;
      expect(params.get("includeContent")).toBe("false");
      const offset = Number(params.get("offset"));
      offsets.push(offset);
      return HttpResponse.json({
        data: Array.from({ length: offset === 0 ? 100 : 1 }, (_, index) => ({
          id: `skill-${offset + index}`,
          name: `skill-${offset + index}`,
          description: "Summary",
          scope: "org",
          usageCount: 1,
          authorId: null,
          authorName: null,
          teams: [],
          users: [],
          content: "",
        })),
      });
    }),
  );
  const skills = await fetchAllSkills();
  expect(skills).toHaveLength(101);
  expect(skills[100]).toMatchObject({
    id: "skill-100",
    name: "skill-100",
    description: "Summary",
  });
  expect(offsets).toEqual([0, 100]);
});

it("shows gateway server counts before fetching tool names for the details view", async () => {
  let toolRequests = 0;
  server.use(
    http.get(`${origin}/api/agents/gateway`, () =>
      HttpResponse.json({ id: "gateway", accessAllTools: true, tools: [] }),
    ),
    http.get(`${origin}/api/internal_mcp_catalog`, () =>
      HttpResponse.json([
        {
          id: "catalog",
          name: "Example server",
          toolCount: 500,
          icon: null,
          description: null,
          serverType: "local",
        },
      ]),
    ),
    http.get(`${origin}/api/internal_mcp_catalog/tools`, () => {
      toolRequests++;
      return HttpResponse.json([
        { catalogId: "catalog", name: "example__search" },
      ]);
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender } = renderHook(
    ({ details }) => useGatewayServers("gateway", { withTools: details }),
    { wrapper, initialProps: { details: false } },
  );
  await waitFor(() => expect(result.current.servers).toHaveLength(1));
  expect(result.current.servers[0]).toMatchObject({
    catalogName: "Example server",
    toolCount: 500,
    tools: [],
  });
  expect(toolRequests).toBe(0);
  rerender({ details: true });
  await waitFor(() =>
    expect(result.current.servers[0].tools).toEqual([
      { name: "search", description: null },
    ]),
  );
  expect(toolRequests).toBe(1);
});

it("loads the gateway roster as one page, filtered by type, without tool payloads", async () => {
  const requested: string[] = [];
  server.use(
    http.get(`${origin}/api/agents`, ({ request }) => {
      const url = new URL(request.url);
      requested.push(url.searchParams.get("agentTypes") ?? "");
      return HttpResponse.json({
        data: [{ id: "gateway", name: "Gateway" }],
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () =>
      useProfiles({
        filters: { agentTypes: ["profile", "mcp_gateway"] },
      }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.data?.[0].name).toBe("Gateway"));
  expect(requested).toEqual(["profile,mcp_gateway"]);
});

it("requests the gateway roster without tool payloads", async () => {
  const requested: URL[] = [];
  server.use(
    http.get(`${origin}/api/agents`, ({ request }) => {
      requested.push(new URL(request.url));
      return HttpResponse.json({
        data: [{ id: "gateway", name: "Gateway" }],
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () =>
      useProfiles({
        filters: { agentTypes: ["profile", "mcp_gateway"] },
      }),
    { wrapper },
  );
  await waitFor(() => expect(result.current.data?.[0].name).toBe("Gateway"));
  expect(requested).toHaveLength(1);
  expect(requested[0].searchParams.has("includeTools")).toBe(false);
});

it("keeps lightweight option data separate from full editing data and retains it on request failure", async () => {
  let failing = false;
  server.use(
    http.get(`${origin}/api/agents/options`, () =>
      failing
        ? HttpResponse.json(
            {
              error: { message: "Temporarily unavailable", type: "api_error" },
            },
            { status: 503 },
          )
        : HttpResponse.json([
            { id: "gateway", name: "Gateway", agentType: "mcp_gateway" },
          ]),
    ),
    http.get(`${origin}/api/agents`, () =>
      HttpResponse.json({
        data: [{ id: "gateway", name: "Gateway" }],
        pagination: { currentPage: 1, limit: 100, total: 1, totalPages: 1 },
      }),
    ),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(
    () => {
      const options = useAgentOptions();
      const full = useProfiles();
      return { options, full, isOptionsError: options.isError };
    },
    { wrapper },
  );
  await waitFor(() => expect(result.current.full.data).toHaveLength(1));
  await waitFor(() =>
    expect(result.current.options.data?.[0].name).toBe("Gateway"),
  );
  expect(result.current.options.data?.[0]).not.toHaveProperty("tools");
  failing = true;
  await result.current.options.refetch();
  await waitFor(() => expect(result.current.isOptionsError).toBe(true));
  expect(result.current.options.data?.[0].name).toBe("Gateway");
  expect(result.current.full.data).toHaveLength(1);
  client.clear();
});
