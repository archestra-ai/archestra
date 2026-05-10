import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("site announcement routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: siteAnnouncementRoutes } = await import(
      "./site-announcement"
    );
    await app.register(siteAnnouncementRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("creates and reads an active announcement", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/site-announcement",
      payload: {
        content: "Read the [status page](https://status.example.com).",
        expiresAt,
      },
    });

    expect(createResponse.statusCode).toBe(200);
    expect(createResponse.json()).toEqual({
      announcement: {
        content: "Read the [status page](https://status.example.com).",
        expiresAt,
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/site-announcement",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      announcement: {
        content: "Read the [status page](https://status.example.com).",
        expiresAt,
      },
    });
  });

  test("hides expired announcements from the active endpoint", async () => {
    const expiresAt = new Date(Date.now() - 60_000).toISOString();

    await app.inject({
      method: "POST",
      url: "/api/site-announcement",
      payload: {
        content: "Expired maintenance message",
        expiresAt,
      },
    });

    const activeResponse = await app.inject({
      method: "GET",
      url: "/api/site-announcement",
    });
    expect(activeResponse.statusCode).toBe(200);
    expect(activeResponse.json()).toEqual({ announcement: null });

    const settingsResponse = await app.inject({
      method: "GET",
      url: "/api/site-announcement/settings",
    });
    expect(settingsResponse.statusCode).toBe(200);
    expect(settingsResponse.json()).toEqual({
      announcement: {
        content: "Expired maintenance message",
        expiresAt,
      },
    });
  });

  test("updates and deletes an announcement", async () => {
    await app.inject({
      method: "POST",
      url: "/api/site-announcement",
      payload: {
        content: "Initial",
        expiresAt: null,
      },
    });

    const updateResponse = await app.inject({
      method: "PATCH",
      url: "/api/site-announcement",
      payload: {
        content: "Updated",
        expiresAt: null,
      },
    });
    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toEqual({
      announcement: {
        content: "Updated",
        expiresAt: null,
      },
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/api/site-announcement",
    });
    expect(deleteResponse.statusCode).toBe(200);

    const settingsResponse = await app.inject({
      method: "GET",
      url: "/api/site-announcement/settings",
    });
    expect(settingsResponse.json()).toEqual({ announcement: null });
  });
});
