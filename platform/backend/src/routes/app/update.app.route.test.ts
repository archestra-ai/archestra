import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { InternalMcpCatalogModel, McpServerModel } from "@/models";
import AppModel from "@/models/app";
import EnvironmentModel from "@/models/environment";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mustExist,
  test,
} from "@/test";
import type { User } from "@/types";

describe("PATCH /api/apps/:appId", () => {
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
    registerAuditLogHook(app);

    const { default: appRoutes } = await import("./app.routes");
    await app.register(appRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("a metadata-only edit updates fields without forking a version", async ({
    makeApp,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { name: "Renamed", description: "new desc" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Renamed",
      description: "new desc",
      latestVersion: created.latestVersion,
    });
  });

  test("toggles the fullscreen-by-default display preference", async ({
    makeApp,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });
    expect(created.openInFullscreen).toBe(false);

    const enabled = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { openInFullscreen: true },
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().openInFullscreen).toBe(true);
    expect(
      mustExist(await AppModel.findById(created.id)).openInFullscreen,
    ).toBe(true);

    // An unrelated edit must not silently reset the preference.
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { name: "Still fullscreen" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().openInFullscreen).toBe(true);

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { openInFullscreen: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().openInFullscreen).toBe(false);
  });

  test("sets and clears the icon, storing it on the app's backing catalog", async ({
    makeApp,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });
    expect(created.icon).toBeNull();

    const set = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { icon: "🚀" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().icon).toBe("🚀");

    // An app has no icon column of its own: the value must land on the backing
    // catalog, which is also what the MCP registry renders for the same entity.
    const server = await McpServerModel.findById(
      mustExist(created.mcpServerId),
    );
    const catalog = await InternalMcpCatalogModel.findById(
      mustExist(server).catalogId,
    );
    expect(catalog?.icon).toBe("🚀");

    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { icon: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().icon).toBeNull();
    expect(mustExist(await AppModel.findById(created.id)).icon).toBeNull();
  });

  test("an icon-only edit is audited with a real before/after diff", async ({
    makeApp,
  }) => {
    // The icon is not an `apps` column, so it reaches the audit snapshot only
    // because that snapshot reads the catalog-joined query. Without it, setting
    // an icon would record an audit entry showing nothing changed.
    const created = await makeApp({ organizationId, scope: "org" });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { icon: "🚀" },
    });
    expect(response.statusCode).toBe(200);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "app.updated"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0].before).toMatchObject({ icon: null });
    expect(rows[0].after).toMatchObject({ icon: "🚀" });
  });

  test("audits an uploaded image icon as a digest, not as its bytes", async ({
    makeApp,
  }) => {
    // An emoji is short enough to audit verbatim; a data URL is not. Embedding
    // one would copy it into both sides of EVERY later app audit event, so it
    // collapses to a digest that still changes when the image does.
    const created = await makeApp({ organizationId, scope: "org" });
    const dataUrl = `data:image/png;base64,${"A".repeat(4096)}`;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { icon: dataUrl },
    });
    expect(response.statusCode).toBe(200);
    // The API still hands back the real icon — only the audit trail is summarized.
    expect(response.json().icon).toBe(dataUrl);

    const [row] = await db
      .select({ after: schema.auditLogsTable.after })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "app.updated"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );
    const auditedIcon = (row.after as Record<string, unknown>).icon;
    expect(auditedIcon).toMatch(/^image:[0-9a-f]{16}$/);
    expect(JSON.stringify(row.after)).not.toContain("AAAA");
  });

  test("an edit that leaves the icon out keeps it", async ({ makeApp }) => {
    // The settings form sends name/description on every save; an omitted icon
    // must not be read as "clear it".
    const created = await makeApp({ organizationId, scope: "org", icon: "🚀" });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { name: "Renamed" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: "Renamed", icon: "🚀" });
  });

  test("supplying html forks a new version", async ({ makeApp }) => {
    const created = await makeApp({ organizationId, scope: "org" });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { html: "<h1>v2</h1>" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().latestVersion).toBe(created.latestVersion + 1);
  });

  test("an admin may re-scope another user's personal app without becoming its owner", async ({
    makeUser,
    makeMember,
    makeApp,
  }) => {
    // `user` is an app admin. Changing a foreign personal app's visibility is a
    // settings change (allowed via oversight), and it must never reassign
    // authorship to the acting admin — the app stays the original author's.
    const otherAuthor = await makeUser();
    await makeMember(otherAuthor.id, organizationId);
    const foreign = await makeApp({
      organizationId,
      scope: "personal",
      authorId: otherAuthor.id,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${foreign.id}`,
      payload: { scope: "org" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      scope: "org",
      authorId: otherAuthor.id,
    });
  });

  test("html cannot be rewritten while the app is disabled, settings changes still can", async ({
    makeApp,
  }) => {
    const created = await makeApp({
      organizationId,
      scope: "org",
      authorId: user.id,
    });
    await AppModel.setEnabled(created.id, false);

    // Rewriting content is authoring; a disabled app is frozen for it — for
    // its author too (T-980), until it is re-enabled.
    const htmlPatch = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { html: "<h1>rewrite while disabled</h1>" },
    });
    expect(htmlPatch.statusCode).toBe(403);
    expect(htmlPatch.json().error.message).toContain("disabled");

    // Managing the disabled app's settings stays possible — that is where
    // renaming/re-scoping ahead of a re-enable happens.
    const namePatch = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { name: "Renamed While Disabled" },
    });
    expect(namePatch.statusCode).toBe(200);
  });

  test("an admin cannot rewrite another user's personal app's html (that is chat-authoring, not settings)", async ({
    makeUser,
    makeMember,
    makeApp,
  }) => {
    // Editing the html IS editing the app itself. An admin who only sees the app
    // through oversight may change its settings but not its content — the same
    // line the modify-via-chat tools draw.
    const otherAuthor = await makeUser();
    await makeMember(otherAuthor.id, organizationId);
    const foreign = await makeApp({
      organizationId,
      scope: "personal",
      authorId: otherAuthor.id,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${foreign.id}`,
      payload: { html: "<h1>admin rewrite</h1>" },
    });
    expect(response.statusCode).toBe(403);
  });

  test("renaming into an existing name returns 409", async () => {
    await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Taken", html: "<p/>", scope: "org" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Other", html: "<p/>", scope: "org" },
    });
    const secondId = second.json().id as string;

    const conflict = await app.inject({
      method: "PATCH",
      url: `/api/apps/${secondId}`,
      payload: { name: "Taken" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  test("rejects changing uiPermissions without supplying html (400)", async ({
    makeApp,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { uiPermissions: { camera: {} } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("requires supplying html");
  });

  test("a plain member cannot update an org-scoped app (403)", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    user = member;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { name: "Hijacked" },
    });
    expect(response.statusCode).toBe(403);
  });

  test("returns 404 when updating an unknown app id", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${crypto.randomUUID()}`,
      payload: { name: "Ghost" },
    });
    expect(response.statusCode).toBe(404);
  });

  test("re-binds the app's environment and back to the default", async ({
    makeApp,
  }) => {
    const prod = await EnvironmentModel.create({
      organizationId,
      name: "production",
    });
    const created = await makeApp({ organizationId, scope: "org" });

    const bound = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { environmentId: prod.id },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().environmentId).toBe(prod.id);

    const back = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { environmentId: null },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json().environmentId).toBeNull();
  });

  test("editing an app bound to a restricted environment does not require deploy-to-restricted when the binding is unchanged", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const restricted = await EnvironmentModel.create({
      organizationId,
      name: "restricted-prod",
      restricted: true,
    });
    // The admin (current `user`) binds the app to the restricted environment.
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Restricted App",
        scope: "org",
        environmentId: restricted.id,
      },
    });
    expect(created.statusCode).toBe(200);
    const appId = created.json().id;

    // An app admin who lacks environment:deploy-to-restricted renames the app;
    // the form echoes the unchanged environmentId. The unchanged binding must
    // not be re-authorized, so the edit succeeds rather than 403.
    const role = await makeCustomRole(organizationId, {
      permission: { app: ["admin"] },
    });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: role.role });
    user = editor;

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/apps/${appId}`,
      payload: { name: "Renamed", environmentId: restricted.id },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Renamed");
  });
  test("shares a personal app with named users, and revokes with an empty list", async ({
    makeUser,
    makeMember,
    makeApp,
  }) => {
    const created = await makeApp({
      organizationId,
      scope: "personal",
      authorId: user.id,
    });
    const colleague = await makeUser();
    await makeMember(colleague.id, organizationId, { role: "member" });

    const shared = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { userIds: [colleague.id] },
    });
    expect(shared.statusCode).toBe(200);
    // The app stays personal — the grant sits beside the scope, not in it.
    expect(shared.json().scope).toBe("personal");
    // PATCH returns the app-with-warnings shape, so read the grant back from
    // the detail route that actually surfaces it.
    const afterShare = await app.inject({
      method: "GET",
      url: `/api/apps/${created.id}`,
    });
    expect(afterShare.json().users).toEqual([
      expect.objectContaining({ id: colleague.id }),
    ]);

    const revoked = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { userIds: [] },
    });
    expect(revoked.statusCode).toBe(200);
    const afterRevoke = await app.inject({
      method: "GET",
      url: `/api/apps/${created.id}`,
    });
    expect(afterRevoke.json().users).toEqual([]);
  });

  test("rejects sharing with a user outside the organization", async ({
    makeUser,
    makeApp,
  }) => {
    const created = await makeApp({
      organizationId,
      scope: "personal",
      authorId: user.id,
    });
    // A real user, but never made a member of this organization.
    const outsider = await makeUser();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { userIds: [outsider.id] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/Unknown user/i);
  });
});

describe("PATCH /api/apps/:appId — slug", () => {
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
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: appRoutes } = await import("./app.routes");
    await app.register(appRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("409s a slug another app in the organization holds", async ({
    makeApp,
  }) => {
    await makeApp({ organizationId, scope: "org", name: "Taken" });
    const mine = await makeApp({ organizationId, scope: "org", name: "Mine" });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${mine.id}`,
      payload: { slug: "taken" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("URL");
    expect(response.json().error.message).not.toContain("app named");
  });

  test("400s a malformed slug without touching the app", async ({
    makeApp,
  }) => {
    const created = await makeApp({
      organizationId,
      scope: "org",
      name: "Sales Dashboard",
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { slug: "Not A Slug" },
    });

    expect(response.statusCode).toBe(400);
    const after = await app.inject({
      method: "GET",
      url: `/api/apps/${created.id}`,
    });
    expect(after.json().slug).toBe("sales-dashboard");
  });
});
