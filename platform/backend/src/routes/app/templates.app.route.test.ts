import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { buildValidatedVersionPayload } from "@/services/apps/app-ui-policy";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "@/test";
import type { User } from "@/types";

describe("GET /api/app-templates", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  const appsEnabled = config.apps.enabled;
  beforeAll(() => {
    (config.apps as { enabled: boolean }).enabled = true;
  });
  afterAll(() => {
    (config.apps as { enabled: boolean }).enabled = appsEnabled;
  });

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

    // The single starter is a pure-UI empty state: its name token is resolved
    // to a neutral default and it carries no SDK bootstrap glue — so it passes
    // the save-time validator unchanged.
    const [starter] = templates;
    expect(starter.html).toContain("My App");
    expect(starter.html).not.toContain("{{APP_NAME}}");
    expect(starter.html).not.toContain("__ARCHESTRA_APP_SDK_URL__");
    expect(starter.html).not.toContain("PostMessageTransport");
    await expect(
      buildValidatedVersionPayload({ html: starter.html }),
    ).resolves.toMatchObject({ warnings: [] });
  });

  test("404s when the feature is disabled", async () => {
    (config.apps as { enabled: boolean }).enabled = false;
    const off = await app.inject({ method: "GET", url: "/api/app-templates" });
    (config.apps as { enabled: boolean }).enabled = true;
    expect(off.statusCode).toBe(404);
  });
});
