import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import SiteNotificationModel from "@/models/site-notification";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("site notification routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeAdmin, makeOrganization }) => {
    user = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: siteNotificationRoutes } = await import(
      "./site-notification"
    );
    registerAuditLogHook(app);
    await app.register(siteNotificationRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("creates and returns the active notification", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/site-notification",
      payload: {
        content: "Scheduled maintenance at 17:00 UTC",
        expiresAt,
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json()).toMatchObject({
      content: "Scheduled maintenance at 17:00 UTC",
      expiresAt,
    });

    const getResponse = await app.inject({
      method: "GET",
      url: "/api/site-notification",
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({
      id: createResponse.json().id,
      content: "Scheduled maintenance at 17:00 UTC",
      expiresAt,
    });
  });

  test("creates an inactive organization slot without ever publishing a banner", async () => {
    const prior = await SiteNotificationModel.create({
      organizationId,
      content: "Previous announcement",
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/site-notification",
      payload: { content: "Inactive draft", isActive: false },
    });
    expect(response.statusCode, response.body).toBe(200);
    const created = response.json();
    expect(created).toMatchObject({
      content: "Inactive draft",
      isActive: false,
    });
    expect(
      (
        await app.inject({ method: "GET", url: "/api/site-notification" })
      ).json(),
    ).toBeNull();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/site-notification/settings",
        })
      ).json(),
    ).toMatchObject({
      id: created.id,
      isActive: false,
      content: "Inactive draft",
    });
    expect(await SiteNotificationModel.getById(prior.id)).toMatchObject({
      isActive: false,
    });
    await vi.waitFor(async () => {
      const audit = await AuditLogModel.findPaginated({
        organizationId,
        resourceId: organizationId,
        limit: 10,
        offset: 0,
      });
      expect(audit.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "organization.updated",
            before: expect.objectContaining({
              content: "Previous announcement",
              isActive: true,
            }),
            after: expect.objectContaining({
              content: "Inactive draft",
              isActive: false,
            }),
          }),
        ]),
      );
    });
  });

  test("concurrent replacements leave one active announcement", async () => {
    const responses = await Promise.all(
      ["First candidate", "Second candidate"].map((content) =>
        app.inject({
          method: "POST",
          url: "/api/site-notification",
          payload: { content },
        }),
      ),
    );
    for (const response of responses)
      expect(response.statusCode, response.body).toBe(200);
    const active = await db
      .select({ id: schema.siteNotificationsTable.id })
      .from(schema.siteNotificationsTable)
      .where(
        and(
          eq(schema.siteNotificationsTable.organizationId, organizationId),
          eq(schema.siteNotificationsTable.isActive, true),
        ),
      );
    expect(active).toHaveLength(1);
    expect(responses.map((response) => response.json().id)).toContain(
      active[0].id,
    );
  });

  test("a failed replacement preserves the currently active announcement", async () => {
    const prior = await SiteNotificationModel.create({
      organizationId,
      content: "Still active",
    });
    vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(
      prior.id as ReturnType<typeof crypto.randomUUID>,
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/site-notification",
      payload: { content: "Rejected replacement", isActive: false },
    });
    expect(response.statusCode).toBe(500);
    expect(await SiteNotificationModel.getActive(organizationId)).toMatchObject(
      { id: prior.id, content: "Still active", isActive: true },
    );
  });

  test("replacing the slot does not deactivate another organization's notification", async ({
    makeOrganization,
  }) => {
    const other = await makeOrganization();
    const untouched = await SiteNotificationModel.create({
      organizationId: other.id,
      content: "Other organization",
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/site-notification",
      payload: { content: "Local inactive draft", isActive: false },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().isActive).toBe(false);
    expect(await SiteNotificationModel.getActive(other.id)).toMatchObject({
      id: untouched.id,
      isActive: true,
    });
  });

  test("returns inactive notifications for settings but not the active banner", async () => {
    const createResponse = await app.inject({
      method: "POST",
      url: "/api/site-notification",
      payload: {
        content: "Draft announcement",
      },
    });

    const notificationId = createResponse.json().id;
    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/site-notification/${notificationId}`,
      payload: {
        isActive: false,
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      id: notificationId,
      content: "Draft announcement",
      isActive: false,
    });

    const activeResponse = await app.inject({
      method: "GET",
      url: "/api/site-notification",
    });
    const settingsResponse = await app.inject({
      method: "GET",
      url: "/api/site-notification/settings",
    });

    expect(activeResponse.statusCode).toBe(200);
    expect(activeResponse.json()).toBeNull();
    expect(settingsResponse.statusCode).toBe(200);
    expect(settingsResponse.json()).toMatchObject({
      id: notificationId,
      content: "Draft announcement",
      isActive: false,
    });
  });

  test("uses the standard error response when updating a missing notification", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/site-notification/missing-notification",
      payload: {
        content: "Updated content",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: {
        message: "Notification not found",
        type: "api_not_found_error",
      },
    });
  });
});
