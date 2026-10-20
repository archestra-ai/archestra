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
      // The connection approval page's reads.
      getClientConnection: vi.fn(),
      getDefaultMcpGateway: vi.fn(),
      getAgentOptions: vi.fn(),
      getAgentOptionsPage: vi.fn(),
      getLlmProxy: vi.fn(),
      getSkillNames: vi.fn(),
      getPlugins: vi.fn(),
      getAvailableLlmProviderApiKeys: vi.fn(),
      getLlmModels: vi.fn(),
      getGuardrailsDeployment: vi.fn(),
      createConnectionSetup: vi.fn(),
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
import {
  CONNECTION_GATEWAY_PAGE_QUERY,
  CONNECTION_GATEWAY_REFERENCE_FILTERS,
  connectionApprovalSeedQueries,
} from "@/lib/connection-approval-seed";
import { environmentKeys } from "@/lib/environment.query";
import { guardrailsDeploymentQueryKey } from "@/lib/guardrails-deployment.query";
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

const REQUEST_ID = "0a1b2c".repeat(8);
const APPROVAL_SEARCH = `?clientId=opencode&platform=linux&connectRequest=${REQUEST_ID}`;
const ADMIN_GATEWAY = "11111111-1111-4111-8111-111111111111";
const DEFAULT_GATEWAY = "22222222-2222-4222-8222-222222222222";
const URL_GATEWAY = "33333333-3333-4333-8333-333333333333";
const connectionOrganization = {
  connectionDefaultMcpGatewayId: ADMIN_GATEWAY,
  connectionLlmProxyEnabled: true,
  connectionSkillsEnabled: true,
  connectionPluginsEnabled: true,
};
const approval = {
  request: { clientId: "opencode", platform: "linux", userCode: "0A1B-2C0A" },
  defaultGateway: { id: DEFAULT_GATEWAY, name: "My Gateway" },
  gatewayPage: { data: [{ id: ADMIN_GATEWAY }], pagination: {} },
  references: { data: [{ id: ADMIN_GATEWAY }, { id: DEFAULT_GATEWAY }] },
  llmProxy: { id: "proxy-1" },
  skillNames: { data: [{ id: "s1", name: "skill" }], total: 1 },
  plugins: [{ id: "plugin-1" }],
  availableApiKeys: [{ id: "key-1" }],
  models: [{ id: "model-1" }],
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
    sdk.getClientConnection
      .mockReset()
      .mockResolvedValue({ data: approval.request });
    sdk.getDefaultMcpGateway
      .mockReset()
      .mockResolvedValue({ data: approval.defaultGateway });
    sdk.getAgentOptions
      .mockReset()
      .mockResolvedValue({ data: approval.references });
    sdk.getAgentOptionsPage
      .mockReset()
      .mockResolvedValue({ data: approval.gatewayPage });
    sdk.getLlmProxy.mockReset().mockResolvedValue({ data: approval.llmProxy });
    sdk.getSkillNames
      .mockReset()
      .mockResolvedValue({ data: approval.skillNames });
    sdk.getPlugins.mockReset().mockResolvedValue({ data: approval.plugins });
    sdk.getAvailableLlmProviderApiKeys
      .mockReset()
      .mockResolvedValue({ data: approval.availableApiKeys });
    sdk.getLlmModels.mockReset().mockResolvedValue({ data: approval.models });
    sdk.createConnectionSetup.mockReset().mockResolvedValue({
      data: {
        id: "setup-1",
        command: "curl https://x/api/connection-setups/secret-token | bash",
      },
    });
    sdk.getGuardrailsDeployment
      .mockReset()
      .mockResolvedValue({ data: { enabled: false } });
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

  it("seeds a connection approval document's shell and every part the page reads, each from its own endpoint", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/connection");
    requestHeaders.set(
      SHELL_SEED_SEARCH_HEADER,
      `${APPROVAL_SEARCH}&gatewayId=${URL_GATEWAY}`,
    );
    getBootstrapMock.mockResolvedValue({
      data: { ...bootstrap, organization: connectionOrganization },
    });

    const seed = await prefetchShellSeed();

    // The gateways the page names by id: the URL's, the admin default and
    // the member's default, read once the default is known.
    const ids = [ADMIN_GATEWAY, DEFAULT_GATEWAY, URL_GATEWAY];
    expect(sdk.getAgentOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          ...CONNECTION_GATEWAY_REFERENCE_FILTERS,
          ids,
        }),
      }),
    );
    expect(sdk.getAgentOptionsPage).toHaveBeenCalledWith(
      expect.objectContaining({ query: CONNECTION_GATEWAY_PAGE_QUERY }),
    );
    expect(sdk.getClientConnection).toHaveBeenCalledWith(
      expect.objectContaining({ path: { id: REQUEST_ID } }),
    );
    expect(seed?.queries).toEqual([
      ...shellQueries,
      ...connectionApprovalSeedQueries({
        connectRequest: REQUEST_ID,
        request: approval.request as never,
        defaultGateway: approval.defaultGateway as never,
        gatewayPage: approval.gatewayPage as never,
        gatewayReferences: { ids, options: approval.references.data as never },
        llmProxy: approval.llmProxy as never,
        skillNames: approval.skillNames as never,
        plugins: approval.plugins as never,
        availableApiKeys: approval.availableApiKeys as never,
        models: approval.models as never,
      }),
    ]);
  });

  it("seeds the guardrails status for the sidebar warning while OpenAPPA is on", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/chat");
    getBootstrapMock.mockResolvedValue({
      data: { ...bootstrap, config: { features: { openappaEnabled: true } } },
    });

    expect((await prefetchShellSeed())?.queries).toContainEqual({
      queryKey: guardrailsDeploymentQueryKey,
      data: { enabled: false },
    });

    getBootstrapMock.mockResolvedValue({ data: bootstrap });
    sdk.getGuardrailsDeployment.mockClear();
    await prefetchShellSeed();
    expect(sdk.getGuardrailsDeployment).not.toHaveBeenCalled();
  });

  it("prepares the approval page's first setup with the document, and seeds only its id", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/connection");
    requestHeaders.set(SHELL_SEED_SEARCH_HEADER, APPROVAL_SEARCH);
    requestHeaders.set("host", "connect.example");
    requestHeaders.set("x-forwarded-proto", "https");
    getBootstrapMock.mockResolvedValue({
      data: {
        ...bootstrap,
        permissions: {
          mcpGateway: ["read"],
          llmProxy: ["read"],
          skill: ["read"],
          llmVirtualKey: ["create"],
        },
        scopedCapabilities: [],
        organization: {
          ...connectionOrganization,
          connectionDefaultClientId: null,
          connectionShownClientIds: null,
          connectionClientProviderKeys: null,
          connectionBaseUrls: null,
        },
      },
    });
    sdk.getAvailableLlmProviderApiKeys.mockResolvedValue({
      data: [
        {
          id: "key-1",
          provider: "openai",
          isPrimary: true,
          baseUrl: "https://llm.example/v1",
        },
      ],
    });

    const seed = await prefetchShellSeed();

    expect(sdk.createConnectionSetup).toHaveBeenCalledTimes(1);
    expect(sdk.createConnectionSetup.mock.calls[0][0].body).toMatchObject({
      clientId: "opencode",
      platform: "linux",
      // The browser's window.location.origin for this document.
      baseUrl: "https://connect.example/v1",
      mcpGatewayId: ADMIN_GATEWAY,
      skills: { skillIds: ["s1"], ttlDays: null },
    });
    const setup = seed?.queries.find(
      ({ queryKey }) => queryKey[0] === "connection-setup-seed",
    );
    expect(setup?.data).toEqual({
      inputsKey: expect.any(String),
      id: "setup-1",
    });
    // The setup's command carries a one-time token; it never lands in the HTML.
    expect(JSON.stringify(seed)).not.toContain("secret-token");
  });

  it("prepares no setup for a speculative load or without the document's origin", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/connection");
    requestHeaders.set(SHELL_SEED_SEARCH_HEADER, APPROVAL_SEARCH);
    getBootstrapMock.mockResolvedValue({
      data: { ...bootstrap, organization: connectionOrganization },
    });

    requestHeaders.set("host", "connect.example");
    requestHeaders.set("sec-purpose", "prefetch;prerender");
    expect(await prefetchShellSeed()).not.toBeNull();
    requestHeaders.delete("sec-purpose");
    requestHeaders.delete("host");
    expect(await prefetchShellSeed()).not.toBeNull();

    expect(sdk.createConnectionSetup).not.toHaveBeenCalled();
  });

  it("reads only the approval page parts the organization turns on", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/connection");
    requestHeaders.set(SHELL_SEED_SEARCH_HEADER, APPROVAL_SEARCH);
    getBootstrapMock.mockResolvedValue({
      data: {
        ...bootstrap,
        organization: {
          connectionDefaultMcpGatewayId: null,
          connectionLlmProxyEnabled: false,
          connectionSkillsEnabled: false,
          connectionPluginsEnabled: false,
        },
      },
    });

    const keys = (await prefetchShellSeed())?.queries.map(
      ({ queryKey }) => queryKey[0],
    );

    expect(sdk.getLlmProxy).not.toHaveBeenCalled();
    expect(sdk.getSkillNames).not.toHaveBeenCalled();
    expect(sdk.getPlugins).not.toHaveBeenCalled();
    expect(keys).toContain("client-connection");
    expect(keys).not.toContain("llm-proxy");
  });

  it("leaves an expired or foreign connection request to the page's error state", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/connection");
    requestHeaders.set(SHELL_SEED_SEARCH_HEADER, APPROVAL_SEARCH);
    getBootstrapMock.mockResolvedValue({
      data: { ...bootstrap, organization: connectionOrganization },
    });
    sdk.getClientConnection.mockResolvedValue({
      data: undefined,
      error: { error: { message: "Not found" } },
    });

    const seed = await prefetchShellSeed();

    expect(seed).not.toBeNull();
    expect(seed?.queries.map(({ queryKey }) => queryKey[0])).not.toContain(
      "client-connection",
    );
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
    requestHeaders.set(SHELL_SEED_HEADER, "/connection");
    requestHeaders.set(SHELL_SEED_SEARCH_HEADER, APPROVAL_SEARCH);
    expect(await prefetchShellSeed()).not.toBeNull();
    // The plain Connect page, and a malformed request id, are not seeded.
    for (const search of ["", "?connectRequest=abc", "?clientId=opencode"]) {
      requestHeaders.set(SHELL_SEED_SEARCH_HEADER, search);
      expect(await prefetchShellSeed()).toBeNull();
    }
    requestHeaders.delete(SHELL_SEED_SEARCH_HEADER);
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
