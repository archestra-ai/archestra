import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("POST /api/apps/:appId/screenshot", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

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

    const { default: appRoutes } = await import("./app.routes");
    await app.register(appRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("records a render screenshot and rejects bad input", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Shots", html: "<h1>v1</h1>", scope: "org" },
    });
    const appId = created.json().id as string;

    const ok = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/screenshot`,
      payload: { version: 1, dataUrl: "data:image/jpeg;base64,QUJD" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().success).toBe(true);

    // a non-image data URL is rejected by the body schema (not stored)
    const badUrl = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/screenshot`,
      payload: { version: 1, dataUrl: "data:text/plain;base64,QUJD" },
    });
    expect(badUrl.statusCode).not.toBe(200);

    // a version ahead of the app's head is rejected by the handler
    const futureVersion = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/screenshot`,
      payload: { version: 99, dataUrl: "data:image/png;base64,QUJD" },
    });
    expect(futureVersion.statusCode).toBe(400);
  });
});
