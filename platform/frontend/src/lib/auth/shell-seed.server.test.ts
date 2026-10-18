import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requestHeaders, getBootstrapMock, getIssueIndexMock, fetchMock } =
  vi.hoisted(() => ({
    requestHeaders: new Map<string, string>(),
    getBootstrapMock: vi.fn(),
    getIssueIndexMock: vi.fn(),
    fetchMock: vi.fn(),
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
    },
  };
});

import { mcpRegistryIssueIndexQueryKey } from "@/lib/mcp/mcp-registry.query";
import { SHELL_SEED_HEADER, SHELL_SEED_ROUTES } from "./shell-seed";
import { prefetchShellSeed } from "./shell-seed.server";

const bootstrap = { permissions: { mcpRegistry: ["read"] } };
const index = { catalogItems: [], servers: [] };

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
  });

  it("resolves nothing for documents the proxy did not mark", async () => {
    expect(await prefetchShellSeed()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getBootstrapMock).not.toHaveBeenCalled();
  });

  it("resolves the session without its token, the bootstrap and the issue index", async () => {
    requestHeaders.set(SHELL_SEED_HEADER, "/mcp/registry");

    const seed = await prefetchShellSeed();

    expect(seed).toEqual({
      session: {
        user: { id: "u1" },
        session: { id: "s1", userId: "u1", activeOrganizationId: "org-1" },
      },
      bootstrap,
      queries: [{ queryKey: mcpRegistryIssueIndexQueryKey, data: index }],
    });
    // A field the app does not read stays out, whatever its name.
    expect(JSON.stringify(seed)).not.toContain("secret-");
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
