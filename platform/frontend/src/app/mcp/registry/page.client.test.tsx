import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { startEarlyMock } = vi.hoisted(() => ({ startEarlyMock: vi.fn() }));

vi.mock("@/lib/mcp/mcp-registry.query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/mcp-registry.query")>()),
  startMcpRegistryEarlyRequests: startEarlyMock,
}));
vi.mock("./_parts/InternalMCPCatalog", () => ({
  InternalMCPCatalog: () => null,
}));

describe("registry route early requests", () => {
  beforeEach(() => {
    vi.resetModules();
    startEarlyMock.mockReset();
    window.history.pushState(null, "", "/mcp/registry");
  });
  afterEach(() => {
    window.history.pushState(null, "", "/");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("start the page and the index on a full page load the server did not render", async () => {
    await import("./page.client");

    expect(startEarlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ index: true }),
    );
  });

  it("start only the page when the server rendered the page but not its rows", async () => {
    document.body.innerHTML =
      '<div hidden data-mcp-registry-seeded="index"></div>';

    await import("./page.client");

    expect(startEarlyMock).toHaveBeenCalledWith(
      expect.objectContaining({ index: false }),
    );
  });

  it("start nothing when the server rendered the first page", async () => {
    document.body.innerHTML =
      '<div hidden data-mcp-registry-seeded="page"></div>';

    await import("./page.client");

    expect(startEarlyMock).not.toHaveBeenCalled();
  });

  it("stay off on a client-side navigation: the link prefetched the page", async () => {
    const { appLifecycle } = await import("@/lib/app-lifecycle");
    appLifecycle.markRendered();

    await import("./page.client");

    expect(startEarlyMock).not.toHaveBeenCalled();
  });
});
