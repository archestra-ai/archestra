import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import { AppVersionModel } from "@/models";
import EnvironmentModel from "@/models/environment";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
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

describe("POST /api/apps", () => {
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

  test("creates an org-scoped app at version 1 for an admin", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Dashboard",
        description: "A shared dashboard",
        html: "<html><head></head><body><h1>ok</h1></body></html>",
        scope: "org",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Dashboard",
      description: "A shared dashboard",
      scope: "org",
      latestVersion: 1,
    });
  });

  test("seeds the default template server-side with the app name when html is omitted", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Seeded" },
    });
    expect(created.statusCode).toBe(200);

    const versions = await app.inject({
      method: "GET",
      url: `/api/apps/${created.json().id}/versions`,
    });
    const { html } = versions.json()[0];
    expect(html).toContain("<title>Seeded</title>");
    expect(html).toContain("<h1>Seeded</h1>");
    expect(html).not.toContain("{{APP_NAME}}");
  });

  test("rejects SDK self-bootstrap html and surfaces soft warnings", async () => {
    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Bootstrapper",
        html: "<html><head><script>import(window.__ARCHESTRA_APP_SDK_URL__);</script></head><body/></html>",
      },
    });
    expect(bootstrap.statusCode).toBe(400);
    expect(bootstrap.json().error.message).toContain("window.archestra");

    // A fragment saves fine but the response carries a structural warning.
    const fragment = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Fragment", html: "<h1>just a heading</h1>" },
    });
    expect(fragment.statusCode).toBe(200);
    expect(fragment.json().warnings).toHaveLength(1);
    expect(fragment.json().warnings[0]).toContain("no <head> or <html>");

    // A complete document carries no warnings field at all.
    const clean = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Clean",
        html: "<html><head></head><body><h1>ok</h1></body></html>",
      },
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.json().warnings).toBeUndefined();
  });

  test("a plain member may create a personal app but not an org-scoped one", async ({
    makeUser,
    makeMember,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    user = member;

    const personal = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Mine", html: "<p/>" },
    });
    expect(personal.statusCode).toBe(200);
    expect(personal.json().scope).toBe("personal");

    const orgApp = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Shared", html: "<p/>", scope: "org" },
    });
    expect(orgApp.statusCode).toBe(403);
  });

  test("ignores a stray uiCsp body key (apps carry no author CSP)", async () => {
    // uiCsp is not an authoring field: the body schema strips it and the serve
    // path pins the platform CSP.
    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "BadCsp",
        html: "<p/>",
        uiCsp: { connectDomains: ["https://evil.example.com"] },
      },
    });
    expect(response.statusCode).toBe(200);
    const created = response.json() as { id: string; latestVersion: number };
    const head = await AppVersionModel.findByAppAndVersion(
      created.id,
      created.latestVersion,
    );
    expect(head).not.toBeNull();
  });

  test("rejects a team-scoped app with no teamIds (400)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Teamless", html: "<p/>", scope: "team" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("at least one teamId");
  });

  test("creates a team-scoped app with a valid team", async ({ makeTeam }) => {
    const team = await makeTeam(organizationId, user.id, { name: "Squad" });

    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Team App",
        html: "<p/>",
        scope: "team",
        teamIds: [team.id],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().scope).toBe("team");
  });

  test("rejects a team id from another organization with 400", async ({
    makeOrganization,
    makeTeam,
  }) => {
    const otherOrg = await makeOrganization();
    const foreignTeam = await makeTeam(otherOrg.id, user.id, {
      name: "Foreign",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Team App",
        html: "<p/>",
        scope: "team",
        teamIds: [foreignTeam.id],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("Unknown team");
  });

  test("binds a new app to an environment", async () => {
    const prod = await EnvironmentModel.create({
      organizationId,
      name: "production",
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Bound", scope: "org", environmentId: prod.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(prod.id);
  });

  test("defaults environmentId to null when omitted", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Default Env", scope: "org" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBeNull();
  });

  test("rejects an environmentId from another organization (404)", async ({
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const foreignEnv = await EnvironmentModel.create({
      organizationId: otherOrg.id,
      name: "foreign",
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "X", scope: "org", environmentId: foreignEnv.id },
    });
    expect(response.statusCode).toBe(404);
  });

  test("an admin may bind to a restricted environment", async () => {
    const restricted = await EnvironmentModel.create({
      organizationId,
      name: "restricted-prod",
      restricted: true,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "R", scope: "org", environmentId: restricted.id },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().environmentId).toBe(restricted.id);
  });

  test("a member without deploy-to-restricted cannot bind to a restricted environment (403)", async ({
    makeUser,
    makeMember,
  }) => {
    const restricted = await EnvironmentModel.create({
      organizationId,
      name: "restricted-prod",
      restricted: true,
    });
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    user = member;

    // Sanity: the member can create a personal app at the default environment,
    // so the 403 below is the restricted-env gate, not a general denial.
    const baseline = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Baseline", scope: "personal" },
    });
    expect(baseline.statusCode).toBe(200);

    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Restricted",
        scope: "personal",
        environmentId: restricted.id,
      },
    });
    expect(response.statusCode).toBe(403);
  });
});
