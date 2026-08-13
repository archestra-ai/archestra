// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { vi } from "vitest";
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
const ADD_ON_TAG = "m-files-vaf-add-on-v1.0.0";
const ADD_ON_ASSET_URL = `https://github.com/archestra-ai/archestra/releases/download/${ADD_ON_TAG}/${ASSET_NAME}`;

/**
 * GitHub releases stub: `listed` is the releases list (newest first) the
 * resolver scans for the add-on asset.
 */
function stubGitHubReleases(params: {
  listed: Array<{
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  }>;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
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
    stubGitHubReleases({ listed: [] });
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

  test("resolves the newest release that actually carries the package", async () => {
    stubGitHubReleases({
      listed: [
        // Newest release is the platform's, which never carries the add-on
        // (releases are immutable, the package publishes on its own track) —
        // must be skipped, not blindly linked.
        { tag_name: "platform-v1.3.35", assets: [] },
        {
          tag_name: ADD_ON_TAG,
          assets: [
            { name: ASSET_NAME, browser_download_url: ADD_ON_ASSET_URL },
          ],
        },
      ],
    });
    const response = await probe();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ packageDownloadUrl: ADD_ON_ASSET_URL });
  });

  test("resolves null when no release carries the package", async () => {
    const response = await probe();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ packageDownloadUrl: null });
  });

  function fetchBootstrap() {
    return app.inject({ method: "GET", url: "/api/mfiles-vaf-add-on/script" });
  }

  test("script bootstrap installs the released package, ref'd to its tag", async () => {
    stubGitHubReleases({
      listed: [
        {
          tag_name: ADD_ON_TAG,
          assets: [
            { name: ASSET_NAME, browser_download_url: ADD_ON_ASSET_URL },
          ],
        },
      ],
    });
    const response = await fetchBootstrap();
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain(
      "Invoke-RestMethod 'http://localhost:3000/scripts/install-m-files-vaf-add-on.ps1'",
    );
    expect(response.body).toContain(`PackageUrl = '${ADD_ON_ASSET_URL}'`);
    expect(response.body).toContain(`Ref = '${ADD_ON_TAG}'`);
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
