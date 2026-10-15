import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
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

it("expands gateway tool schemas only when requested and retains the result afterwards", async () => {
  let previews = 0;
  server.use(
    http.get(`${origin}/api/agents/gateway/mcp-tool-preview`, () => {
      previews++;
      return HttpResponse.json({
        tools: [{ name: "example__search", tokens: 12 }],
        tokenCount: { total: 12 },
      });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender } = renderHook(
    ({ enabled }) =>
      useGatewayToolPreview({ agentId: "gateway", client: "generic", enabled }),
    { wrapper, initialProps: { enabled: false } },
  );
  expect(result.current.fetchStatus).toBe("idle");
  expect(previews).toBe(0);
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.data?.tools).toHaveLength(1));
  expect(previews).toBe(1);
  rerender({ enabled: false });
  expect(result.current.data?.tokenCount?.total).toBe(12);
  expect(previews).toBe(1);
});
