import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { SiteModel } from "@/models";
import { SITE_CHANNEL_PREFIX } from "@/routes/route-paths";
import { signSiteToken } from "@/sites/channel-auth";
import { postToSite, SiteUnavailableError } from "@/sites/channel-client";
import { clearSitesCache } from "@/sites/registry";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import siteChannelRoutes from "./site-channel";

/**
 * Two sites in one process: "azure-us" calls "gcp-us", whose channel route
 * runs here. The site name in config is switched while "gcp-us" answers.
 */
describe("site channel", () => {
  let app: ReturnType<typeof createFastifyInstance>;

  beforeEach(async () => {
    clearSitesCache();
    app = createFastifyInstance();
    await app.register(siteChannelRoutes);
    await SiteModel.upsert({
      name: "gcp-us",
      role: "secondary",
      internalUrl: "http://gcp-us.site-channel.test",
      version: "test",
      capabilities: { keylessProviders: [] },
    });
    config.site.name = "azure-us";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      config.site.name = "gcp-us";
      try {
        const response = await app.inject({
          method: "POST",
          url: url.pathname,
          headers: init?.headers as Record<string, string>,
          payload: init?.body as string,
        });
        return new Response(response.body, { status: response.statusCode });
      } finally {
        config.site.name = "azure-us";
      }
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    config.site.name = "default";
    await app.close();
  });

  test("a signed call reaches the other site, which knows the caller", async () => {
    const response = await postToSite({
      siteName: "gcp-us",
      path: "/health",
      body: {},
      what: "Health check",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "gcp-us",
      caller: "azure-us",
    });
  });

  test("a draining site is refused before any call, naming the site", async () => {
    await SiteModel.setDraining("gcp-us", true);
    clearSitesCache();
    await expect(
      postToSite({
        siteName: "gcp-us",
        path: "/health",
        body: {},
        what: "Health check",
      }),
    ).rejects.toThrow(
      new SiteUnavailableError(
        "gcp-us",
        'Health check needs site "gcp-us", which is draining',
      ),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("refuses a request without a valid site token", async () => {
    config.site.name = "gcp-us";
    const body = "{}";
    const unsigned = await app.inject({
      method: "POST",
      url: `${SITE_CHANNEL_PREFIX}/health`,
      headers: { "content-type": "application/json" },
      payload: body,
    });
    expect(unsigned.statusCode).toBe(401);
    const forAnotherSite = await app.inject({
      method: "POST",
      url: `${SITE_CHANNEL_PREFIX}/health`,
      headers: {
        "content-type": "application/json",
        "x-archestra-site-token": signSiteToken({
          to: "gcp-eu",
          body,
          from: "azure-us",
        }),
      },
      payload: body,
    });
    expect(forAnotherSite.statusCode).toBe(401);
  });
});
