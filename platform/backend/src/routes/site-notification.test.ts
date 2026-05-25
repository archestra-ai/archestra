import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
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
    await app.register(siteNotificationRoutes);
  });

  afterEach(async () => {
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
