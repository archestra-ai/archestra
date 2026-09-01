// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

// cacheManager needs a live PostgreSQL connection that PGlite tests don't
// have; the canonical Map-backed fake lets rate limiting run for real.
vi.mock("@/cache-manager");

// Unique per test process: the routes module caches the resolved packed
// package per directory, so the directory's contents must not change for the
// life of this file.
const PACKED_DIR = vi.hoisted(
  () => `/tmp/archestra-vaf-add-on-packed-test-${process.pid}`,
);

// No source-ref override: distribution should come from the package compiled
// into the image (this directory stands in for the image's
// /app/mfiles-vaf-add-on).
vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    kb: {
      mfilesConnectorEnabled: true,
      mfilesVafAddOnPackageDir: PACKED_DIR,
    },
  }),
);

const PACKED_VERSION = "1.2.3";
const VERSIONED_FILENAME = `archestra-m-files-vaf-add-on-${PACKED_VERSION}.mfappx`;
const PACKED_BYTES = Buffer.from("packed-mfappx-package-bytes");

let remoteAddressCounter = 0;
/** Unique IP per request so the per-IP rate limit never bleeds between tests. */
function nextRemoteAddress(): string {
  remoteAddressCounter += 1;
  return `10.4.${Math.floor(remoteAddressCounter / 250)}.${(remoteAddressCounter % 250) + 1}`;
}

describe("Archestra VAF Add On packed into the platform image", () => {
  let app: FastifyInstanceWithZod;

  beforeAll(async () => {
    await rm(PACKED_DIR, { recursive: true, force: true });
    await mkdir(PACKED_DIR, { recursive: true });
    // The image writes the versioned file plus a stable-named copy; the
    // versioned one is what resolution keys on.
    await writeFile(join(PACKED_DIR, VERSIONED_FILENAME), PACKED_BYTES);
    await writeFile(
      join(PACKED_DIR, "archestra-m-files-vaf-add-on.mfappx"),
      PACKED_BYTES,
    );
    return async () => {
      await rm(PACKED_DIR, { recursive: true, force: true });
    };
  });

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    // Any GitHub call would be a regression: the packed package must resolve
    // without touching the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not Found", { status: 404 })),
    );
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

  test("distribution points the download link at the package route without calling GitHub", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/mfiles-vaf-add-on/distribution",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      packageDownloadUrl: "/api/mfiles-vaf-add-on/package",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("script bootstrap installs the packed package with the version's release tag as fallback ref", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/mfiles-vaf-add-on/script",
      remoteAddress: nextRemoteAddress(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      "PackageUrl = 'http://localhost:3000/api/mfiles-vaf-add-on/package'",
    );
    expect(response.body).toContain(
      `Ref = 'm-files-vaf-add-on-v${PACKED_VERSION}'`,
    );
    expect(response.body).not.toContain("BuildFromSource");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("package route serves the packed bytes under the versioned filename", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/mfiles-vaf-add-on/package",
      remoteAddress: nextRemoteAddress(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toContain(
      `filename="${VERSIONED_FILENAME}"`,
    );
    expect(response.rawPayload.equals(PACKED_BYTES)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
