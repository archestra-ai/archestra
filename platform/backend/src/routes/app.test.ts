import { ADMIN_ROLE_NAME } from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import { AppRenderDiagnosticsModel, AppVersionModel } from "@/models";
import { buildValidatedVersionPayload } from "@/services/apps/app-ui-policy";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import appRoutes from "./app";

const originalAppsEnabled = config.apps.enabled;
beforeAll(() => {
  (config.apps as { enabled: boolean }).enabled = true;
});
afterAll(() => {
  (config.apps as { enabled: boolean }).enabled = originalAppsEnabled;
});

async function buildApp(
  userId: string,
  organizationId: string,
): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest("user");
  app.decorateRequest("organizationId");
  app.addHook("preHandler", (request, _reply, done) => {
    // biome-ignore lint/suspicious/noExplicitAny: test hook sets auth context
    (request as any).user = { id: userId, email: "t@t.com", name: "T" };
    // biome-ignore lint/suspicious/noExplicitAny: test hook sets auth context
    (request as any).organizationId = organizationId;
    done();
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply
        .status(error.statusCode)
        .send({ error: { message: error.message, type: error.type } });
    }
    const err = error as Error & { statusCode?: number };
    return reply
      .status(err.statusCode ?? 500)
      .send({ error: { message: err.message } });
  });
  await app.register(appRoutes);
  return app;
}

const JSON_HEADERS = { "content-type": "application/json" };

describe("appRoutes /api/apps", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  test("the whole surface 404s when the feature is disabled", async ({
    makeUser,
    makeOrganization,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    (config.apps as { enabled: boolean }).enabled = false;
    app = await buildApp(user.id, org.id);
    const response = await app.inject({ method: "GET", url: "/api/apps" });
    (config.apps as { enabled: boolean }).enabled = true;
    expect(response.statusCode).toBe(404);
  });

  test("create → get → list → update (forks version) → delete", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    app = await buildApp(user.id, org.id);

    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
      payload: { name: "Dashboard", html: "<h1>v1</h1>", scope: "org" },
    });
    expect(created.statusCode).toBe(200);
    const appId = created.json().id as string;
    expect(created.json().latestVersion).toBe(1);

    const got = await app.inject({ method: "GET", url: `/api/apps/${appId}` });
    expect(got.json().name).toBe("Dashboard");

    const listed = await app.inject({ method: "GET", url: "/api/apps" });
    expect(listed.json().data.map((a: { id: string }) => a.id)).toContain(
      appId,
    );
    expect(listed.json().pagination.total).toBeGreaterThanOrEqual(1);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/apps/${appId}`,
      headers: JSON_HEADERS,
      payload: { html: "<h1>v2</h1>" },
    });
    expect(updated.json().latestVersion).toBe(2);

    const versions = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/versions`,
    });
    expect(versions.json()).toHaveLength(2);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().success).toBe(true);
  });

  test("records a render screenshot and rejects bad input", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    app = await buildApp(user.id, org.id);

    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
      payload: { name: "Shots", html: "<h1>v1</h1>", scope: "org" },
    });
    const appId = created.json().id as string;

    const ok = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/screenshot`,
      headers: JSON_HEADERS,
      payload: { version: 1, dataUrl: "data:image/jpeg;base64,QUJD" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().success).toBe(true);

    // a non-image data URL is rejected by the body schema (not stored)
    const badUrl = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/screenshot`,
      headers: JSON_HEADERS,
      payload: { version: 1, dataUrl: "data:text/plain;base64,QUJD" },
    });
    expect(badUrl.statusCode).not.toBe(200);

    // a version ahead of the app's head is rejected by the handler
    const futureVersion = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/screenshot`,
      headers: JSON_HEADERS,
      payload: { version: 99, dataUrl: "data:image/png;base64,QUJD" },
    });
    expect(futureVersion.statusCode).toBe(400);
  });

  test("create seeds the default template server-side when html is omitted", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    app = await buildApp(user.id, org.id);

    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
      payload: { name: "Seeded" },
    });
    expect(created.statusCode).toBe(200);
    const versions = await app.inject({
      method: "GET",
      url: `/api/apps/${created.json().id}/versions`,
    });
    expect(versions.json()[0].html).toContain(
      "window.archestra.storage.user.set",
    );
    expect(versions.json()[0].html).toContain("window.archestra.tools.call");
  });

  test("create rejects SDK self-bootstrap html and surfaces soft warnings", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    app = await buildApp(user.id, org.id);

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
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
      headers: JSON_HEADERS,
      payload: { name: "Fragment", html: "<h1>just a heading</h1>" },
    });
    expect(fragment.statusCode).toBe(200);
    expect(fragment.json().warnings).toHaveLength(1);
    expect(fragment.json().warnings[0]).toContain("no <head> or <html>");

    // A complete document carries no warnings field at all.
    const clean = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
      payload: {
        name: "Clean",
        html: "<html><head></head><body><h1>ok</h1></body></html>",
      },
    });
    expect(clean.statusCode).toBe(200);
    expect(clean.json().warnings).toBeUndefined();
  });

  test("a plain member cannot create an org-scoped app", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const member = await makeUser();
    await makeMember(member.id, org.id, { role: "member" });
    app = await buildApp(member.id, org.id);

    const personal = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
      payload: { name: "Mine", html: "<p/>" },
    });
    expect(personal.statusCode).toBe(200);

    const orgApp = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
      payload: { name: "Shared", html: "<p/>", scope: "org" },
    });
    expect(orgApp.statusCode).toBe(403);
  });

  test("renaming into an existing name returns 409", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    app = await buildApp(user.id, org.id);

    await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
      payload: { name: "Taken", html: "<p/>", scope: "org" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
      payload: { name: "Other", html: "<p/>", scope: "org" },
    });
    const secondId = second.json().id as string;

    const conflict = await app.inject({
      method: "PATCH",
      url: `/api/apps/${secondId}`,
      headers: JSON_HEADERS,
      payload: { name: "Taken" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  test("create ignores a stray uiCsp body key (apps carry no author CSP)", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    app = await buildApp(user.id, org.id);

    // uiCsp is not an authoring field: the body schema strips it and the serve
    // path pins the platform CSP.
    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
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

  test("a user cannot GET an app belonging to another organization", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeApp,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();
    const appInA = await makeApp({ organizationId: orgA.id, scope: "org" });
    const intruder = await makeUser();
    await makeMember(intruder.id, orgB.id, { role: ADMIN_ROLE_NAME });
    app = await buildApp(intruder.id, orgB.id);

    const response = await app.inject({
      method: "GET",
      url: `/api/apps/${appInA.id}`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("rejects a team-scoped app with no teamIds (400)", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    app = await buildApp(user.id, org.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
      payload: { name: "Teamless", html: "<p/>", scope: "team" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("at least one teamId");
  });

  test("creates a team-scoped app with a valid team", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const team = await makeTeam(org.id, user.id, { name: "Squad" });
    app = await buildApp(user.id, org.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
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
    makeUser,
    makeOrganization,
    makeMember,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const admin = await makeUser();
    await makeMember(admin.id, org.id, { role: ADMIN_ROLE_NAME });
    const foreignTeam = await makeTeam(otherOrg.id, admin.id, {
      name: "Foreign",
    });
    app = await buildApp(admin.id, org.id);

    const response = await app.inject({
      method: "POST",
      url: "/api/apps",
      headers: JSON_HEADERS,
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

  test("rejects changing uiPermissions without supplying html (400)", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const created = await makeApp({ organizationId: org.id, scope: "org" });
    app = await buildApp(user.id, org.id);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      headers: JSON_HEADERS,
      payload: { uiPermissions: { camera: {} } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("requires supplying html");
  });

  test("assign then unassign a tool", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeApp,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const created = await makeApp({ organizationId: org.id, scope: "org" });
    const catalog = await makeInternalMcpCatalog({
      organizationId: org.id,
      name: "srv",
      serverUrl: "https://example.com/mcp/",
    });
    const tool = await makeTool({
      name: "srv__do_thing",
      parameters: {},
      catalogId: catalog.id,
    });
    app = await buildApp(user.id, org.id);

    const assigned = await app.inject({
      method: "POST",
      url: `/api/apps/${created.id}/tools/${tool.id}`,
      headers: JSON_HEADERS,
      // Late-bound resolution avoids needing a concrete MCP server install.
      payload: { credentialResolutionMode: "dynamic" },
    });
    expect(assigned.statusCode).toBe(200);

    const tools = await app.inject({
      method: "GET",
      url: `/api/apps/${created.id}/tools`,
    });
    expect(tools.json().map((t: { id: string }) => t.id)).toContain(tool.id);

    const unassigned = await app.inject({
      method: "DELETE",
      url: `/api/apps/${created.id}/tools/${tool.id}`,
    });
    expect(unassigned.statusCode).toBe(200);
  });

  test("assigning a tool from another organization returns 404", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeApp,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const created = await makeApp({ organizationId: org.id, scope: "org" });
    const foreignCatalog = await makeInternalMcpCatalog({
      organizationId: otherOrg.id,
      name: "foreign-srv",
      serverUrl: "https://example.com/mcp/",
    });
    const foreignTool = await makeTool({
      name: "foreign__do_thing",
      parameters: {},
      catalogId: foreignCatalog.id,
    });
    app = await buildApp(user.id, org.id);

    const assigned = await app.inject({
      method: "POST",
      url: `/api/apps/${created.id}/tools/${foreignTool.id}`,
      headers: JSON_HEADERS,
      payload: { credentialResolutionMode: "dynamic" },
    });
    expect(assigned.statusCode).toBe(404);
  });

  test("lists app templates when enabled, 404 when disabled", async ({
    makeUser,
    makeOrganization,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    app = await buildApp(user.id, org.id);

    const listed = await app.inject({
      method: "GET",
      url: "/api/app-templates",
    });
    expect(listed.statusCode).toBe(200);
    const templates = listed.json() as Array<{ id: string; html: string }>;
    expect(templates.map((t) => t.id)).toEqual(["default"]);
    // The single starter is pure UI: it uses the injected window.archestra
    // runtime, demonstrates storage + tool calls, and carries no SDK bootstrap
    // glue itself — so it passes the save-time validator unchanged.
    const [starter] = templates;
    expect(starter.html).toContain("window.archestra.storage.user.set");
    expect(starter.html).toContain("window.archestra.tools.call");
    expect(starter.html).not.toContain("__ARCHESTRA_APP_SDK_URL__");
    expect(starter.html).not.toContain("PostMessageTransport");
    await expect(
      buildValidatedVersionPayload({ html: starter.html }),
    ).resolves.toMatchObject({ warnings: [] });

    (config.apps as { enabled: boolean }).enabled = false;
    const off = await app.inject({ method: "GET", url: "/api/app-templates" });
    (config.apps as { enabled: boolean }).enabled = true;
    expect(off.statusCode).toBe(404);
  });

  test("POST diagnostics stores the snapshot for the session user", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });
    const app = await buildApp(user.id, org.id);

    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Diag", html: "<h1>v1</h1>", scope: "org" },
    });
    const appId = created.json().id as string;

    const posted = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/diagnostics`,
      payload: { version: 1, entries: [{ type: "error", message: "boom" }] },
    });
    expect(posted.statusCode).toBe(200);

    const stored = await AppRenderDiagnosticsModel.getForUser(appId, user.id);
    expect(stored?.entries).toEqual([{ type: "error", message: "boom" }]);

    // a version past the app's head is rejected (can't have rendered yet)
    const future = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/diagnostics`,
      payload: { version: 99, entries: [] },
    });
    expect(future.statusCode).toBe(400);
  });

  test("POST diagnostics 404s for an app the caller cannot see", async ({
    makeUser,
    makeOrganization,
    makeMember,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const author = await makeUser();
    await makeMember(author.id, org.id, { role: ADMIN_ROLE_NAME });
    // a personal app owned by the author is invisible to another member
    const personalApp = await makeApp({
      organizationId: org.id,
      scope: "personal",
      authorId: author.id,
    });
    const other = await makeUser();
    await makeMember(other.id, org.id, { role: "member" });
    const app = await buildApp(other.id, org.id);

    const posted = await app.inject({
      method: "POST",
      url: `/api/apps/${personalApp.id}/diagnostics`,
      payload: { version: 1, entries: [] },
    });
    expect(posted.statusCode).toBe(404);
    expect(
      await AppRenderDiagnosticsModel.getForUser(personalApp.id, other.id),
    ).toBeNull();
  });
});
