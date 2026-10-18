import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config/config", () => ({
  getBackendBaseUrl: () => "http://localhost:9000",
}));

const PNG_A =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==";
const PNG_B =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let favicons: typeof import("./favicon.server");
const fetchMock = vi.fn();

describe("getCachedDeploymentAppearance", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    favicons = await import("./favicon.server");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("answers documents from the last read without asking the backend again", async () => {
    fetchMock.mockResolvedValue(Response.json({ favicon: PNG_A }));
    const { favicon: first } = await favicons.getCachedDeploymentAppearance();
    const { favicon: second } = await favicons.getCachedDeploymentAppearance();

    expect(first.version).toMatch(/^[0-9a-f]{16}$/);
    expect(second.href).toBe(first.href);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves the previous favicon once while a stale entry refreshes, then the new one", async () => {
    fetchMock.mockResolvedValue(Response.json({ favicon: PNG_A }));
    const { favicon: before } = await favicons.getCachedDeploymentAppearance();

    fetchMock.mockResolvedValue(Response.json({ favicon: PNG_B }));
    vi.advanceTimersByTime(30_000);
    // Stale: answered at once from the cache, refresh started behind it.
    expect((await favicons.getCachedDeploymentAppearance()).favicon.href).toBe(
      before.href,
    );
    await vi.waitFor(async () =>
      expect(
        (await favicons.getCachedDeploymentAppearance()).favicon.href,
      ).not.toBe(before.href),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not hold a cold document longer than the cold wait", async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    const pending = favicons.getCachedDeploymentAppearance();
    await vi.advanceTimersByTimeAsync(200);

    await expect(pending).resolves.toMatchObject({
      favicon: { href: "/default-favicon.ico", version: null },
      theme: null,
    });
  });

  it("keeps the last good favicon when the backend fails, and tries again next time", async () => {
    fetchMock.mockResolvedValue(Response.json({ favicon: PNG_A }));
    const { favicon: good } = await favicons.getCachedDeploymentAppearance();

    fetchMock.mockRejectedValue(new Error("backend unavailable"));
    expect((await favicons.getDeploymentFavicon()).href).toBe(good.href);

    fetchMock.mockResolvedValue(Response.json({ favicon: PNG_B }));
    expect((await favicons.getDeploymentFavicon()).href).not.toBe(good.href);
  });

  it("carries the organization's theme from the same cached read", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ favicon: null, theme: "cosmic-night" }),
    );
    const appearance = await favicons.getCachedDeploymentAppearance();
    expect(appearance.theme).toBe("cosmic-night");
    expect(favicons.themeClassName(appearance.theme)).toBe(
      "theme-cosmic-night",
    );
    // Nothing more is asked of the backend for it.
    await favicons.getCachedDeploymentAppearance();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default theme rather than none", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ favicon: null, theme: "not-a-theme" }),
    );
    const appearance = await favicons.getCachedDeploymentAppearance();
    expect(appearance.theme).toBeNull();
    expect(favicons.themeClassName(appearance.theme)).toBe("theme-caffeine");
  });
});
