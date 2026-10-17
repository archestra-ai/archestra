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
    fetchMock.mockReset().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { id: "u1" },
          session: { userId: "u1", token: "secret-token" },
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
      session: { user: { id: "u1" }, session: { userId: "u1" } },
      bootstrap,
      queries: [{ queryKey: mcpRegistryIssueIndexQueryKey, data: index }],
    });
    expect(JSON.stringify(seed)).not.toContain("secret-token");
  });

  it("resolves the shell for any page added to the seeded routes, and for no other", async () => {
    const routes = SHELL_SEED_ROUTES as string[];
    routes.push("/mcp/gateways");
    try {
      requestHeaders.set(SHELL_SEED_HEADER, "/mcp/gateways");
      expect(await prefetchShellSeed()).not.toBeNull();
      requestHeaders.set(SHELL_SEED_HEADER, "/agents");
      expect(await prefetchShellSeed()).toBeNull();
    } finally {
      routes.pop();
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
