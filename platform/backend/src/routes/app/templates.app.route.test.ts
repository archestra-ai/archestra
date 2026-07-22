import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { buildValidatedVersionPayload } from "@/services/apps/app-ui-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/app-templates", () => {
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

  test("lists the curated starter templates", async () => {
    const listed = await app.inject({
      method: "GET",
      url: "/api/app-templates",
    });
    expect(listed.statusCode).toBe(200);
    const templates = listed.json() as Array<{ id: string; html: string }>;
    expect(templates.map((t) => t.id)).toEqual(["default"]);

    // The single starter is a pure-UI empty state with no SDK bootstrap glue —
    // it passes the save-time validator unchanged. (Token resolution itself is
    // pinned by app-templates/index.test.ts.)
    const [starter] = templates;
    await expect(
      buildValidatedVersionPayload({ html: starter.html }),
    ).resolves.toMatchObject({ warnings: [] });
  });
});
