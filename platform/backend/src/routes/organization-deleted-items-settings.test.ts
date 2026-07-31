import { DEFAULT_SOFT_DELETE_RETENTION_DAYS } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("PATCH /api/organization/deleted-items-settings", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    const adminUser: User = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(adminUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { user: unknown; organizationId: string }
      ).user = adminUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: organizationRoutes } = await import("./organization");
    await app.register(organizationRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("defaults to a 30-day window with auto-purge on", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/organization",
    });

    expect(response.json()).toMatchObject({
      softDeleteRetentionDays: DEFAULT_SOFT_DELETE_RETENTION_DAYS,
      softDeleteAutoPurgeEnabled: true,
    });
  });

  test("updates the retention window", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/deleted-items-settings",
      payload: { softDeleteRetentionDays: 7 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().softDeleteRetentionDays).toBe(7);
  });

  test("turns auto-purge off without losing the window", async () => {
    await app.inject({
      method: "PATCH",
      url: "/api/organization/deleted-items-settings",
      payload: { softDeleteRetentionDays: 14 },
    });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/deleted-items-settings",
      payload: { softDeleteAutoPurgeEnabled: false },
    });

    expect(response.json()).toMatchObject({
      softDeleteRetentionDays: 14,
      softDeleteAutoPurgeEnabled: false,
    });
  });

  test("rejects a zero-day window", async () => {
    // Zero is not "keep forever" here — that is the auto-purge switch. A 0-day
    // window would let the next sweep invalidate an Undo just offered to a user.
    const response = await app.inject({
      method: "PATCH",
      url: "/api/organization/deleted-items-settings",
      payload: { softDeleteRetentionDays: 0 },
    });

    expect(response.statusCode).toBe(400);
  });

  test("rejects a negative or fractional window", async () => {
    const negative = await app.inject({
      method: "PATCH",
      url: "/api/organization/deleted-items-settings",
      payload: { softDeleteRetentionDays: -5 },
    });
    expect(negative.statusCode).toBe(400);

    const fractional = await app.inject({
      method: "PATCH",
      url: "/api/organization/deleted-items-settings",
      payload: { softDeleteRetentionDays: 1.5 },
    });
    expect(fractional.statusCode).toBe(400);
  });
});
