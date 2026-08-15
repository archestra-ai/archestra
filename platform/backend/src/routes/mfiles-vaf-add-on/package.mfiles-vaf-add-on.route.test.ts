// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import JSZip from "jszip";
import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

// cacheManager needs a live PostgreSQL connection that PGlite tests don't
// have; the canonical Map-backed fake lets rate limiting and the GitHub
// lookup caches run for real (reset before every test).
vi.mock("@/cache-manager");

// Dev source-ref override active for this whole file: the install command
// and the package route should distribute the branch's CI build.
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    kb: {
      mfilesConnectorEnabled: true,
      mfilesVafAddOnSourceRef: "piercypixel/test-branch",
      mfilesVafAddOnGithubToken: "ghp_test-token",
    },
  }),
);

const PACKAGE_BYTES = Buffer.from("mock-mfappx-package-bytes");
const ARTIFACT_ZIP_URL =
  "https://api.github.com/repos/archestra-ai/archestra/actions/artifacts/42/zip";

/**
 * GitHub API stub for the CI-artifact resolution chain: workflow runs →
 * run artifacts → artifact zip download. `artifacts: null` makes the run
 * list empty (no CI build for the ref).
 */
function stubGitHubCi(params: { hasArtifact: boolean }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/actions/workflows/")) {
        expect(url).toContain("branch=piercypixel%2Ftest-branch");
        return Response.json({
          workflow_runs: params.hasArtifact
            ? [
                {
                  artifacts_url:
                    "https://api.github.com/repos/archestra-ai/archestra/actions/runs/1/artifacts",
                },
              ]
            : [],
        });
      }
      if (url.endsWith("/actions/runs/1/artifacts")) {
        return Response.json({
          artifacts: [
            {
              id: 42,
              name: "m-files-vaf-add-on",
              expired: false,
              archive_download_url: ARTIFACT_ZIP_URL,
            },
          ],
        });
      }
      if (url === ARTIFACT_ZIP_URL) {
        const zip = new JSZip();
        zip.file("archestra-m-files-vaf-add-on.mfappx", PACKAGE_BYTES);
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        return new Response(new Uint8Array(bytes), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    }),
  );
}

let remoteAddressCounter = 0;
/** Unique IP per request so the per-IP rate limit never bleeds between tests. */
function nextRemoteAddress(): string {
  remoteAddressCounter += 1;
  return `10.3.${Math.floor(remoteAddressCounter / 250)}.${(remoteAddressCounter % 250) + 1}`;
}

describe("Archestra VAF Add On dev source-ref override", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    stubGitHubCi({ hasArtifact: true });
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

  test("script bootstrap installs the branch CI build through the package proxy", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/mfiles-vaf-add-on/script",
      remoteAddress: nextRemoteAddress(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      "PackageUrl = 'http://localhost:3000/api/mfiles-vaf-add-on/package'",
    );
    expect(response.body).toContain("Ref = 'piercypixel/test-branch'");
    expect(response.body).not.toContain("BuildFromSource");
  });

  test("script bootstrap compiles from the ref's source when no CI build exists", async () => {
    stubGitHubCi({ hasArtifact: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/mfiles-vaf-add-on/script",
      remoteAddress: nextRemoteAddress(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("BuildFromSource = $true");
    expect(response.body).toContain("Ref = 'piercypixel/test-branch'");
    expect(response.body).not.toContain("PackageUrl");
  });

  test("distribution points the download link at the package proxy", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/mfiles-vaf-add-on/distribution",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      packageDownloadUrl: "/api/mfiles-vaf-add-on/package",
    });
  });

  test("package route unwraps and serves the CI artifact's .mfappx", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/mfiles-vaf-add-on/package",
      remoteAddress: nextRemoteAddress(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toContain(
      'filename="archestra-m-files-vaf-add-on.mfappx"',
    );
    expect(response.rawPayload.equals(PACKAGE_BYTES)).toBe(true);
  });

  test("package route 404s when the ref has no CI build", async () => {
    stubGitHubCi({ hasArtifact: false });
    const response = await app.inject({
      method: "GET",
      url: "/api/mfiles-vaf-add-on/package",
      remoteAddress: nextRemoteAddress(),
    });
    expect(response.statusCode).toBe(404);
  });
});
