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

  test("creates and returns the active announcement", async () => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/site-announcement",
      payload: {
        markdown: "**Heads up:** [status](https://example.com)",
        expiresAt: "2999-01-01T00:00:00.000Z",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      organizationId,
      markdown: "**Heads up:** [status](https://example.com)",
    });

    const activeResponse = await app.inject({
      method: "GET",
      url: "/api/site-announcement/active",
    });

    expect(activeResponse.statusCode).toBe(200);
    expect(activeResponse.json()).toMatchObject({
      organizationId,
      markdown: "**Heads up:** [status](https://example.com)",
    });
  });

  test("replaces the existing announcement instead of creating another", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/site-announcement",
      payload: {
        markdown: "First announcement",
        expiresAt: null,
      },
    });

    const response = await app.inject({
      method: "PUT",
      url: "/api/site-announcement",
      payload: {
        markdown: "Second announcement",
        expiresAt: null,
      },
    });

    expect(response.statusCode).toBe(200);

    const getResponse = await app.inject({
      method: "GET",
      url: "/api/site-announcement",
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json().markdown).toBe("Second announcement");
  });

  test("does not return expired announcements as active", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/site-announcement",
      payload: {
        markdown: "Expired announcement",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/site-announcement/active",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toBeNull();
  });

  test("deletes the announcement", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/site-announcement",
      payload: {
        markdown: "Temporary announcement",
        expiresAt: null,
      },
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/api/site-announcement",
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({ success: true });

    const getResponse = await app.inject({
      method: "GET",
      url: "/api/site-announcement",
    });

    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toBeNull();
  });
});
