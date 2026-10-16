import { archestraApiClient } from "@archestra/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  useAgentCredentialReadiness,
  useChatAgentPage,
  useChatAgentReferences,
  useChatAgents,
} from "./agent.query";
import { useInitialChatModelState } from "./chat/use-initial-chat-model-state.hook";

const origin = "http://localhost:9000";
const server = setupServer();
const agent = (id: string) => ({
  id,
  name: `Agent ${id}`,
  scope: "org",
  builtIn: false,
  modelId: null,
  llmApiKeyId: null,
});
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  archestraApiClient.setConfig({ baseUrl: origin });
});
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
  localStorage.clear();
});
afterAll(() => {
  server.close();
  archestraApiClient.setConfig({ baseUrl: "" });
});
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(["auth", "session"], { user: { id: "viewer" } });
  client.setQueryData(["organization", "details"], {
    defaultAgentId: "org-default",
  });
  client.setQueryData(["member-default-agent"], {
    defaultAgentId: "member-default",
    personalChatAgentId: null,
  });
  return {
    client,
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  };
}

it("waits for exact preferred references before resolving a project default outside the bootstrap", async () => {
  const requests: URL[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get(`${origin}/api/agents/chat-roster`, async ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      if (url.searchParams.get("bootstrap") === "true")
        return HttpResponse.json([agent("fallback")]);
      expect((url.searchParams.get("ids")?.split(",") ?? []).sort()).toEqual([
        "member-default",
        "org-default",
        "project-default",
      ]);
      await held;
      return HttpResponse.json([
        agent("project-default"),
        agent("member-default"),
        agent("org-default"),
      ]);
    }),
  );
  const { wrapper } = setup();
  const { result } = renderHook(
    () => {
      const roster = useChatAgents({ ids: ["project-default"] });
      const state = useInitialChatModelState({
        agents: roster.data ?? [],
        resolveAgent: roster.resolveAgent,
        isAgentsLoading: roster.isPending,
        organization: { defaultAgentId: "org-default" },
        defaultAgentId: "member-default",
        projectDefaultAgentId: "project-default",
        modelsByProvider: {},
        chatApiKeys: [],
        memberDefault: null,
        canUseSavedAgent: true,
        isPermissionResolving: false,
        isOrgLoading: false,
      });
      return { roster, state };
    },
    { wrapper },
  );
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(result.current.state.agentId).toBeNull();
  await act(async () => release());
  await waitFor(() =>
    expect(result.current.state.agentId).toBe("project-default"),
  );
  expect(
    requests.every(
      (url) => url.searchParams.has("bootstrap") || url.searchParams.has("ids"),
    ),
  ).toBe(true);
});

it("fetches only explicit pages and preserves an off-page manual selection from the picker cache", async () => {
  const requests: URL[] = [];
  server.use(
    http.get(`${origin}/api/agents/chat-roster/page`, ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      return HttpResponse.json({
        data: [
          {
            ...agent("later-agent"),
            llmApiKeyId: "owned-key",
            runtime: { credentials: [] },
          },
        ],
        pagination: { limit: 20, nextCursor: "next-page", hasNext: true },
      });
    }),
    http.get(`${origin}/api/agents/chat-roster`, ({ request }) => {
      const url = new URL(request.url);
      return HttpResponse.json(
        url.searchParams.has("bootstrap")
          ? [agent("fallback")]
          : [agent("org-default"), agent("member-default")],
      );
    }),
  );
  const { wrapper } = setup();
  const { result, rerender } = renderHook(
    ({ enabled, cursor, search }) => {
      const roster = useChatAgents();
      const page = useChatAgentPage({ enabled, cursor, search });
      const state = useInitialChatModelState({
        agents: roster.data ?? [],
        resolveAgent: roster.resolveAgent,
        isAgentsLoading: roster.isPending,
        organization: null,
        defaultAgentId: null,
        modelsByProvider: {},
        chatApiKeys: [],
        memberDefault: null,
        canUseSavedAgent: true,
        isPermissionResolving: false,
        isOrgLoading: false,
      });
      return { page, state };
    },
    {
      wrapper,
      initialProps: {
        enabled: false,
        cursor: undefined as string | undefined,
        search: "",
      },
    },
  );
  await waitFor(() => expect(result.current.state.agentId).toBe("fallback"));
  expect(requests).toHaveLength(0);
  rerender({ enabled: true, cursor: undefined, search: "description match" });
  await waitFor(() => expect(result.current.page.isSuccess).toBe(true));
  expect(requests).toHaveLength(1);
  expect(requests[0].searchParams.get("limit")).toBe("20");
  expect(requests[0].searchParams.get("search")).toBe("description match");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  act(() => result.current.state.onAgentChange("later-agent"));
  expect(result.current.state.agentId).toBe("later-agent");
  expect(result.current.state.selectedAgent?.llmApiKeyId).toBe("owned-key");
  expect(result.current.state.selectedAgent?.runtime).toEqual({
    credentials: [],
  });
  rerender({ enabled: true, cursor: "next-page", search: "description match" });
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1].searchParams.get("cursor")).toBe("next-page");
});

it("bounds explicit pinned reference batches without discarding later pins", async () => {
  const ids = Array.from({ length: 205 }, (_, index) => `pin-${index}`);
  const batches: string[][] = [];
  server.use(
    http.get(`${origin}/api/agents/chat-roster`, ({ request }) => {
      const requested =
        new URL(request.url).searchParams.get("ids")?.split(",") ?? [];
      batches.push(requested);
      return HttpResponse.json(requested.map(agent));
    }),
  );
  const { wrapper } = setup();
  const { result } = renderHook(() => useChatAgentReferences(ids), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(batches.map((batch) => batch.length)).toEqual([100, 100, 5]);
  expect(new Set(result.current.data?.map((row) => row.id))).toEqual(
    new Set(ids),
  );
});

it("keeps credential readiness scoped to the selected agents and separate in cache", async () => {
  const requests: string[][] = [];
  server.use(
    http.get(`${origin}/api/agents/credential-readiness`, ({ request }) => {
      const ids =
        new URL(request.url).searchParams.get("ids")?.split(",") ?? [];
      requests.push(ids);
      return HttpResponse.json(
        ids.map((agentId) => ({
          agentId,
          missingConnections: [],
          behavior: "warn",
        })),
      );
    }),
  );
  const { wrapper } = setup();
  const { result } = renderHook(
    () => ({
      first: useAgentCredentialReadiness({ ids: ["first"] }),
      second: useAgentCredentialReadiness({ ids: ["second"] }),
    }),
    { wrapper },
  );
  await waitFor(() =>
    expect(
      result.current.first.isSuccess && result.current.second.isSuccess,
    ).toBe(true),
  );
  expect(requests).toEqual([["first"], ["second"]]);
  expect(result.current.first.data?.map((row) => row.agentId)).toEqual([
    "first",
  ]);
  expect(result.current.second.data?.map((row) => row.agentId)).toEqual([
    "second",
  ]);
});

it("exposes a failed default lookup and retries it without silently choosing a fallback", async () => {
  let available = false;
  server.use(
    http.get(`${origin}/api/members/default-agent`, () =>
      available
        ? HttpResponse.json({
            defaultAgentId: "member-default",
            personalChatAgentId: null,
          })
        : HttpResponse.json(
            { error: { message: "Temporarily unavailable" } },
            { status: 503 },
          ),
    ),
    http.get(`${origin}/api/organization`, () =>
      HttpResponse.json({ defaultAgentId: "org-default" }),
    ),
    http.get(`${origin}/api/agents/chat-roster`, ({ request }) => {
      const query = new URL(request.url).searchParams;
      return HttpResponse.json(
        query.has("bootstrap")
          ? [agent("fallback")]
          : (query.get("ids")?.split(",") ?? []).map(agent),
      );
    }),
  );
  const { client, wrapper } = setup();
  client.removeQueries({ queryKey: ["member-default-agent"] });
  const { result } = renderHook(() => useChatAgents(), { wrapper });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(result.current.isPending).toBe(false);
  expect(result.current.data).toBeUndefined();
  available = true;
  await act(async () => {
    await result.current.refetch();
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data?.map((row) => row.id)).toContain("member-default");
});
