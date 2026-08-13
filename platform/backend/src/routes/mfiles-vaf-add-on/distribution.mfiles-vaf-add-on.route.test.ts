// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { vi } from "vitest";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");
vi.mock("@/cache-manager");

// The M-Files connector beta gate is on for this whole file; the disabled
// state is pinned by disabled.mfiles-vaf-add-on.route.test.ts.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    kb: { mfilesConnectorEnabled: true },
  }),
);

const ASSET_NAME = "archestra-m-files-vaf-add-on.mfappx";

/**
 * GitHub releases stub: `tagAssets` answers the version-tag lookup (null =
 * 404), `listed` is the releases list (newest first) for the fallback scan.
 */
function stubGitHubReleases(params: {
  tagAssets: Array<{ name: string }> | null;
  listed: Array<{
    assets: Array<{ name: string; browser_download_url: string }>;
  }>;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/releases/tags/")) {
        return params.tagAssets
          ? Response.json({ assets: params.tagAssets })
          : new Response("Not Found", { status: 404 });
      }
      if (url.includes("/releases?")) {
        return Response.json(params.listed);
      }
      return new Response("Not Found", { status: 404 });
    }),
  );
}

describe("GET /api/mfiles-vaf-add-on/distribution", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    stubGitHubReleases({ tagAssets: null, listed: [] });
    const organization = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, organization.id);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organization.id;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: mfilesVafAddOnRoutes } = await import(
      "./mfiles-vaf-add-on.routes"
    );
    await app.register(mfilesVafAddOnRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  function probe() {
    return app.inject({
      method: "GET",
      url: "/api/mfiles-vaf-add-on/distribution",
    });
  }

  test("prefers this installation's release when it carries the package", async () => {
    stubGitHubReleases({
      tagAssets: [{ name: ASSET_NAME }],
      listed: [],
    });
    const response = await probe();
    expect(response.statusCode).toBe(200);
    const tag = `platform-v${config.api.version}`;
    expect(response.json()).toEqual({
      packageDownloadUrl: `https://github.com/archestra-ai/archestra/releases/download/${tag}/${ASSET_NAME}`,
    });
  });

  test("falls back to the newest release that actually carries the package", async () => {
    const pinnedUrl = `https://github.com/archestra-ai/archestra/releases/download/platform-v0.9.9/${ASSET_NAME}`;
    stubGitHubReleases({
      tagAssets: null,
      listed: [
        // Newest release predates the add-on CI — must be skipped, not
        // blindly linked (releases/latest/download would 404).
        { assets: [] },
        { assets: [{ name: ASSET_NAME, browser_download_url: pinnedUrl }] },
      ],
    });
    const response = await probe();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ packageDownloadUrl: pinnedUrl });
  });

  test("resolves null when no release carries the package", async () => {
    const response = await probe();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ packageDownloadUrl: null });
  });

  function fetchBootstrap() {
    return app.inject({ method: "GET", url: "/api/mfiles-vaf-add-on/script" });
  }

  test("script bootstrap pins this installation's release", async () => {
    stubGitHubReleases({ tagAssets: [{ name: ASSET_NAME }], listed: [] });
    const response = await fetchBootstrap();
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    const tag = `platform-v${config.api.version}`;
    expect(response.body).toContain(
      "Invoke-RestMethod 'http://localhost:3000/scripts/install-m-files-vaf-add-on.ps1'",
    );
    expect(response.body).toContain(
      `PackageUrl = 'https://github.com/archestra-ai/archestra/releases/download/${tag}/${ASSET_NAME}'`,
    );
    expect(response.body).toContain(`Ref = '${tag}'`);
  });

  test("script bootstrap runs installer defaults when nothing resolves", async () => {
    const response = await fetchBootstrap();
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("PackageUrl");
    expect(response.body).not.toContain("Ref =");
    expect(response.body).toContain(
      "& ([scriptblock]::Create($installer)) @vafAddOnParams",
    );
  });
});
