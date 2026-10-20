import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestHeaders, getBootstrapMock, getIssueIndexMock, fetchMock, sdk } =
  vi.hoisted(() => ({
    requestHeaders: new Map<string, string>(),
    getBootstrapMock: vi.fn(),
    getIssueIndexMock: vi.fn(),
    fetchMock: vi.fn(),
    // The shell's other reads, by SDK function.
    sdk: {
      getSiteNotification: vi.fn(),
      getChatConversations: vi.fn(),
      getProjects: vi.fn(),
      getApps: vi.fn(),
      getDefaultCredentialsStatus: vi.fn(),
      getK8sCapabilities: vi.fn(),
      getNewChatBootstrap: vi.fn(),
      getConversationBootstrap: vi.fn(),
      getMyAgentRuns: vi.fn(),
      getMyAgentRun: vi.fn(),
    },
  }));

vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) => requestHeaders.get(name) ?? null,
  }),
}));
vi.mock("@/lib/utils/server", () => ({
  getServerApiHeaders: async () => ({ Cookie: "session=1" }),
}));
vi.mock("@archestra/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@archestra/shared")>();
  return {
    ...actual,
    archestraApiSdk: {
      ...actual.archestraApiSdk,
      getBootstrap: getBootstrapMock,
      getMcpRegistryIssueIndex: getIssueIndexMock,
      ...sdk,
    },
  };
});

import {
  agentRunQueryKey,
  myAgentRunsQueryKey,
} from "@/lib/agent-runs-query-keys";
import { appsQueryKey, SIDEBAR_PINNED_APPS_QUERY } from "@/lib/app.query";
import { authQueryKeys } from "@/lib/auth/auth.query";
import {
  conversationQueryKey,
  conversationsQueryKey,
} from "@/lib/chat/conversations-query-key";
import { newChatSeedQueries } from "@/lib/chat/new-chat-seed";
import { environmentKeys } from "@/lib/environment.query";
import { mcpRegistryIssueIndexQueryKey } from "@/lib/mcp/mcp-registry.query";
import {
  projectListQueryKey,
  SIDEBAR_PINNED_PROJECTS_QUERY,
} from "@/lib/projects/projects.query";
import { siteNotificationKeys } from "@/lib/site-notification.query";
import {
  SHELL_SEED_HEADER,
  SHELL_SEED_ROUTES,
  SHELL_SEED_SEARCH_HEADER,
} from "./shell-seed";
import { prefetchShellSeed } from "./shell-seed.server";

const bootstrap = { permissions: { mcpRegistry: ["read"] } };
const index = { catalogItems: [], servers: [] };
const notification = { id: "n1", content: "**Maintenance** tonight" };
const conversations = [{ id: "c1", title: "First" }];
const projects = { data: [{ id: "p1", pinnedAt: "2026-01-01" }] };
const apps = { data: [{ id: "a1", pinnedAt: "2026-01-01" }] };
const capabilities = { networkPolicy: { enforcementStatus: "unknown" } };
const CONVERSATION_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const RUN_ID = "0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const conversation = {
  id: CONVERSATION_ID,
  encryptedChat: false,
  messages: [{ id: "m40" }],
  olderMessageCount: 39,
};
const newChat = {
  roster: [{ id: "agent-1" }],
  apiKeys: [],
  availableApiKeys: [],
  models: [],
  agent: null,
};

// What every seeded route's shell carries, under its query's key.
const shellQueries = [
  { queryKey: siteNotificationKeys.active(), data: notification },
  { queryKey: conversationsQueryKey(), data: conversations },
  {
    queryKey: projectListQueryKey(SIDEBAR_PINNED_PROJECTS_QUERY),
    data: projects,
  },
  { queryKey: appsQueryKey(SIDEBAR_PINNED_APPS_QUERY), data: apps },
  { queryKey: authQueryKeys.defaultCredentialsEnabled(), data: true },
  { queryKey: environmentKeys.k8sCapabilities(), data: capabilities },
];

describe("prefetchShellSeed", () => {
  beforeEach(() => {
    requestHeaders.clear();
    vi.stubGlobal("fetch", fetchMock);
    // A new response per call: a body reads once, and a test may resolve
    // the shell for several routes.
    fetchMock.mockReset().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            user: { id: "u1" },
            session: {
              id: "s1",
              userId: "u1",
              activeOrganizationId: "org-1",
              token: "secret-token",
              refreshToken: "secret-refresh",
            },
          }),
          { status: 200 },
        ),
    );
    getBootstrapMock.mockReset().mockResolvedValue({ data: bootstrap });
    getIssueIndexMock.mockReset().mockResolvedValue({ data: index });
    sdk.getSiteNotification
      .mockReset()
      .mockResolvedValue({ data: notification });
    sdk.getChatConversations
      .mockReset()
      .mockResolvedValue({ data: conversations });
    sdk.getProjects.mockReset().mockResolvedValue({ data: projects });
    sdk.getApps.mockReset().mockResolvedValue({ data: apps });
    sdk.getDefaultCredentialsStatus
      .mockReset()
      .mockResolvedValue({ data: { enabled: true } });
    sdk.getK8sCapabilities
      .mockReset()
      .mockResolvedValue({ data: capabilities });
    sdk.getNewChatBootstrap.mockReset().mockResolvedValue({ data: newChat });
    sdk.getMyAgentRuns.mockReset().mockImplementation(async ({ query }) => ({
      data: { data: [{ taskId: `run-${query.sort}` }], pagination: {} },
    }));
    sdk.getMyAgentRun
      .mockReset()
      .mockResolvedValue({ data: { taskId: RUN_ID, endedAt: "2026-01-01" } });
    sdk.getConversationBootstrap.mockReset().mockResolvedValue({
      data: { conversation, composer: newChat },
    });
  });

  it("resolves nothing for documents the proxy did not mark", async () => {
    expect(await prefetchShellSeed()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getBootstrapMock).not.toHaveBeenCalled();
  });

  it("resolves the session without its token, the bootstrap, the shell's reads and the issue index", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/mcp/registry");

    const seed = await prefetchShellSeed();

    expect(seed).toEqual({
      session: {
        user: { id: "u1" },
        session: { id: "s1", userId: "u1", activeOrganizationId: "org-1" },
      },
      bootstrap,
      queries: [
        ...shellQueries,
        { queryKey: mcpRegistryIssueIndexQueryKey, data: index },
      ],
    });
    // A field the app does not read stays out, whatever its name.
    expect(JSON.stringify(seed)).not.toContain("secret-");
  });

  it("seeds the new-chat screen's shell and its composer from one read", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/chat");
    requestHeaders.set(SHELL_SEED_SEARCH_HEADER, "");

    const seed = await prefetchShellSeed();

    // The banner is in the HTML, so the browser sends no request for it
    // before the shell is ready; the composer's parts come with it.
    expect(seed?.queries).toEqual([
      ...shellQueries,
      ...newChatSeedQueries(newChat as never),
    ]);
    expect(sdk.getNewChatBootstrap).toHaveBeenCalledTimes(1);
    expect(getIssueIndexMock).not.toHaveBeenCalled();
    expect(sdk.getChatConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { includeArtifacts: false, limit: conversationsQueryKey()[2] },
      }),
    );
  });

  it("leaves the composer to the browser when the URL chooses the agent", async () => {
    for (const search of ["?agentId=agent-2", "?project=project-1"]) {
      requestHeaders.set(SHELL_SEED_HEADER, "/chat");
      requestHeaders.set(SHELL_SEED_SEARCH_HEADER, search);

      expect((await prefetchShellSeed())?.queries).toEqual(shellQueries);
    }
    expect(sdk.getNewChatBootstrap).not.toHaveBeenCalled();
  });

  it("seeds a conversation's end and its composer from one read", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, `/chat/${CONVERSATION_ID}`);

    const seed = await prefetchShellSeed();

    expect(seed?.queries).toEqual([
      ...shellQueries,
      { queryKey: conversationQueryKey(CONVERSATION_ID), data: conversation },
      ...newChatSeedQueries(newChat as never),
    ]);
    expect(sdk.getConversationBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: CONVERSATION_ID } }),
    );
    expect(sdk.getNewChatBootstrap).not.toHaveBeenCalled();
  });

  it("seeds a run page's shell and the run's details", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, `/chat/runs/${RUN_ID}`);

    expect((await prefetchShellSeed())?.queries).toEqual([
      ...shellQueries,
      {
        queryKey: agentRunQueryKey(RUN_ID),
        data: { taskId: RUN_ID, endedAt: "2026-01-01" },
      },
    ]);
    expect(sdk.getMyAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({ path: { taskId: RUN_ID } }),
    );
    expect(sdk.getConversationBootstrap).not.toHaveBeenCalled();
  });

  it("leaves an encrypted or unreadable conversation to the browser, keeping the shell", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, `/chat/${CONVERSATION_ID}`);
    sdk.getConversationBootstrap.mockResolvedValueOnce({
      data: {
        conversation: { ...conversation, encryptedChat: true },
        composer: newChat,
      },
    });
    expect((await prefetchShellSeed())?.queries).toEqual(shellQueries);

    sdk.getConversationBootstrap.mockResolvedValueOnce({
      data: undefined,
      error: { error: { message: "Conversation not found" } },
    });
    expect((await prefetchShellSeed())?.queries).toEqual(shellQueries);
  });

  it("seeds the sidebar's runs as their lists' first pages once the bootstrap says agents run here", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/chat");
    getBootstrapMock.mockResolvedValue({
      data: { ...bootstrap, config: { features: { agentRuntime: true } } },
    });

    const queries = (await prefetchShellSeed())?.queries ?? [];

    expect(queries).toContainEqual({
      queryKey: myAgentRunsQueryKey({ pinned: false }),
      data: {
        pages: [{ data: [{ taskId: "run-recent" }], pagination: {} }],
        pageParams: [0],
      },
    });
    expect(queries).toContainEqual({
      queryKey: myAgentRunsQueryKey({ pinned: true }),
      data: {
        pages: [{ data: [{ taskId: "run-pinned" }], pagination: {} }],
        pageParams: [0],
      },
    });
    expect(sdk.getMyAgentRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { limit: 20, offset: 0, sort: "pinned", pinned: true },
      }),
    );
  });

  it("does not read runs where the deployment runs no agents", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/chat");
    getBootstrapMock.mockResolvedValue({
      data: { ...bootstrap, config: { features: { agentRuntime: false } } },
    });

    expect(await prefetchShellSeed()).not.toBeNull();
    expect(sdk.getMyAgentRuns).not.toHaveBeenCalled();
  });

  it("leaves out a read the viewer may not make, so its query loads as before", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/chat");
    sdk.getK8sCapabilities.mockResolvedValue({
      data: undefined,
      error: { error: { message: "Forbidden" } },
    });
    sdk.getProjects.mockRejectedValue(new Error("network"));

    const keys = (await prefetchShellSeed())?.queries.map(
      ({ queryKey }) => queryKey,
    );

    expect(keys).not.toContainEqual(environmentKeys.k8sCapabilities());
    expect(keys).not.toContainEqual(
      projectListQueryKey(SIDEBAR_PINNED_PROJECTS_QUERY),
    );
    expect(keys).toContainEqual(siteNotificationKeys.active());
  });

  it("resolves the shell for every seeded route, and for no other", async () => {
    // Reads the list as it is, so a page added to it is covered here too.
    for (const route of SHELL_SEED_ROUTES) {
      requestHeaders.set(SHELL_SEED_HEADER, route);
      expect(await prefetchShellSeed()).not.toBeNull();
    }
    requestHeaders.set(SHELL_SEED_HEADER, `/chat/${CONVERSATION_ID}`);
    expect(await prefetchShellSeed()).not.toBeNull();
    for (const path of ["/agents", "/mcp/gateways", "/chat/abc"]) {
      requestHeaders.set(SHELL_SEED_HEADER, path);
      expect(await prefetchShellSeed()).toBeNull();
    }
  });

  it("resolves nothing for a visitor who is not signed in", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/mcp/registry");
    fetchMock.mockResolvedValue(new Response("null", { status: 200 }));

    expect(await prefetchShellSeed()).toBeNull();
  });

  describe("with a backend that does not answer", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("gives up after its deadline, so the page renders unseeded", async () => {
      requestHeaders.set(SHELL_SEED_HEADER, "/mcp/registry");
      vi.useFakeTimers();
      getBootstrapMock.mockReturnValue(new Promise(() => {}));

      const seed = prefetchShellSeed();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(await seed).toBeNull();
    });
  });
});
