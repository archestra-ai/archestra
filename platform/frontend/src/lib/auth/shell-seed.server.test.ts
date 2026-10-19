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

import { appsQueryKey, SIDEBAR_PINNED_APPS_QUERY } from "@/lib/app.query";
import { authQueryKeys } from "@/lib/auth/auth.query";
import { conversationsQueryKey } from "@/lib/chat/conversations-query-key";
import { environmentKeys } from "@/lib/environment.query";
import { mcpRegistryIssueIndexQueryKey } from "@/lib/mcp/mcp-registry.query";
import {
  projectListQueryKey,
  SIDEBAR_PINNED_PROJECTS_QUERY,
} from "@/lib/projects/projects.query";
import { siteNotificationKeys } from "@/lib/site-notification.query";
import { SHELL_SEED_HEADER, SHELL_SEED_ROUTES } from "./shell-seed";
import { prefetchShellSeed } from "./shell-seed.server";

const bootstrap = { permissions: { mcpRegistry: ["read"] } };
const index = { catalogItems: [], servers: [] };
const notification = { id: "n1", content: "**Maintenance** tonight" };
const conversations = [{ id: "c1", title: "First" }];
const projects = { data: [{ id: "p1", pinnedAt: "2026-01-01" }] };
const apps = { data: [{ id: "a1", pinnedAt: "2026-01-01" }] };
const capabilities = { networkPolicy: { enforcementStatus: "unknown" } };

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

  it("seeds the new-chat screen's shell: banner, sidebar and warnings", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/chat");

    const seed = await prefetchShellSeed();

    // The banner is in the HTML, so the browser sends no request for it
    // before the shell is ready.
    expect(seed?.queries).toEqual(shellQueries);
    expect(getIssueIndexMock).not.toHaveBeenCalled();
    expect(sdk.getChatConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { includeArtifacts: false, limit: conversationsQueryKey()[2] },
      }),
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
    for (const path of ["/agents", "/mcp/gateways"]) {
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
