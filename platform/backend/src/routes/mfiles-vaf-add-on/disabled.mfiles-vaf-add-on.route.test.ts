// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");
vi.mock("@/cache-manager");

// No config mock: the M-Files connector beta gate is off by default, which is
// exactly the state under test. These routes are public, so while the gate is
// off they must answer 404 — indistinguishable from the feature not existing.
describe("mfiles-vaf-add-on routes with the M-Files connector gate off", () => {
  let app: FastifyInstanceWithZod;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
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

  test.for([
    "/api/mfiles-vaf-add-on/script",
    "/api/mfiles-vaf-add-on/distribution",
    "/api/mfiles-vaf-add-on/package",
  ])("%s answers 404", async (url) => {
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(404);
  });
});
