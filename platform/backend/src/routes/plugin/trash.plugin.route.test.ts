import { ADMIN_ROLE_NAME, EDITOR_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { PluginModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import pluginRoutes from "./plugin.routes";

/**
 * A deleted plugin's way back and its way out: the deleted list, restore and
 * permanent delete.
 */
describe("the plugin trash", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(pluginRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const createPlugin = async (
    displayName: string,
    options: { sourceId?: string } = {},
  ) => {
    const plugin = await PluginModel.create({
      organizationId,
      userId: user.id,
      sourceId: options.sourceId,
      input: {
        displayName,
        description: "A plugin for the trash.",
        clientType: "claude-code",
        files: [
          {
            path: "README.md",
            content: "Instructions",
            encoding: "utf8",
            mode: "100644",
          },
        ],
      },
    });
    if (!plugin) throw new Error("Missing plugin");
    return plugin;
  };

  const del = (id: string) =>
    app.inject({ method: "DELETE", url: `/api/plugins/${id}` });
  const restore = (id: string) =>
    app.inject({ method: "POST", url: `/api/plugins/${id}/restore` });
  const purge = (id: string) =>
    app.inject({ method: "DELETE", url: `/api/plugins/${id}/permanent` });
  const list = (query = "") =>
    app.inject({ method: "GET", url: `/api/plugins${query}` });
  const names = (response: { json: () => Array<{ displayName: string }> }) =>
    response.json().map((plugin) => plugin.displayName);
  const auditRows = (action: string, resourceId: string) =>
    db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, action as never),
          eq(schema.auditLogsTable.resourceId, resourceId),
        ),
      );

  describe("GET /api/plugins?status=deleted", () => {
    test("lists deleted plugins apart from the live ones", async () => {
      const kept = await createPlugin("Kept");
      const gone = await createPlugin("Gone");
      expect((await del(gone.id)).statusCode).toBe(200);

      expect(names(await list())).toEqual([kept.displayName]);
      const deleted = await list("?status=deleted");
      expect(deleted.statusCode).toBe(200);
      expect(names(deleted)).toEqual([gone.displayName]);
    });

    test("is refused to a member who does not manage every plugin", async ({
      makeUser,
      makeMember,
    }) => {
      const editor = await makeUser();
      await makeMember(editor.id, organizationId, { role: EDITOR_ROLE_NAME });
      user = editor;

      expect((await list("?status=deleted")).statusCode).toBe(403);
      // The live list is still theirs to read.
      expect((await list()).statusCode).toBe(200);
    });
  });

  describe("POST /api/plugins/:id/restore", () => {
    test("brings a deleted plugin back with its files, and audits it", async () => {
      const plugin = await createPlugin("Comes back");
      expect((await del(plugin.id)).statusCode).toBe(200);

      const response = await restore(plugin.id);

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        id: plugin.id,
        displayName: "Comes back",
        deletedAt: null,
        files: [expect.objectContaining({ path: "README.md" })],
      });
      expect(names(await list())).toEqual(["Comes back"]);
      expect(names(await list("?status=deleted"))).toEqual([]);

      const rows = await auditRows("plugin.restored", plugin.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].before).toMatchObject({ id: plugin.id });
      expect(rows[0].after).toMatchObject({ id: plugin.id, deletedAt: null });
    });

    test("a repeated restore returns the live plugin instead of a 404", async () => {
      const plugin = await createPlugin("Twice");
      expect((await del(plugin.id)).statusCode).toBe(200);
      expect((await restore(plugin.id)).statusCode).toBe(200);

      const again = await restore(plugin.id);

      expect(again.statusCode).toBe(200);
      expect(again.json().id).toBe(plugin.id);
      // Nothing was restored the second time, so nothing more is recorded.
      expect(await auditRows("plugin.restored", plugin.id)).toHaveLength(1);
    });

    test("404 for an id that names no plugin", async () => {
      const response = await restore("00000000-0000-4000-8000-000000000000");
      expect(response.statusCode).toBe(404);
    });

    test("409 when a live plugin has taken the deleted one's place", async () => {
      const first = await createPlugin("Shipped", { sourceId: "shipped-one" });
      expect((await del(first.id)).statusCode).toBe(200);
      // Deleting freed the identity; a new plugin took it.
      await createPlugin("Shipped again", { sourceId: "shipped-one" });

      const response = await restore(first.id);

      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain("Cannot restore");
      expect(
        await PluginModel.findDeletedById({ id: first.id, organizationId }),
      ).not.toBeNull();
    });

    test("409 when the owner has given the deleted plugin's name to another one since", async () => {
      const first = await createPlugin("Tools");
      expect((await del(first.id)).statusCode).toBe(200);
      // Deleting freed the name; the same owner used it again, in another
      // letter case.
      const second = await createPlugin("tools");

      const response = await restore(first.id);

      expect(response.statusCode).toBe(409);
      expect(response.json().error.message).toContain("Cannot restore");
      expect(
        await PluginModel.findDeletedById({ id: first.id, organizationId }),
      ).not.toBeNull();

      // With the name free again, the restore goes through.
      expect((await del(second.id)).statusCode).toBe(200);
      expect((await restore(first.id)).statusCode).toBe(200);
    });

    test("is refused to someone who may not delete the plugin", async ({
      makeUser,
      makeMember,
    }) => {
      const plugin = await createPlugin("Not theirs");
      expect((await del(plugin.id)).statusCode).toBe(200);
      const stranger = await makeUser();
      await makeMember(stranger.id, organizationId, {
        role: EDITOR_ROLE_NAME,
      });
      user = stranger;

      // A plugin they cannot even read is not confirmed to exist.
      expect((await restore(plugin.id)).statusCode).toBe(404);
      expect(
        await PluginModel.findDeletedById({ id: plugin.id, organizationId }),
      ).not.toBeNull();
    });
  });

  describe("DELETE /api/plugins/:id/permanent", () => {
    test("destroys a deleted plugin and its files, and audits it without their contents", async () => {
      const plugin = await createPlugin("Gone for good");
      expect((await del(plugin.id)).statusCode).toBe(200);

      const response = await purge(plugin.id);

      expect(response.statusCode, response.body).toBe(200);
      expect(
        await db
          .select({ id: schema.pluginsTable.id })
          .from(schema.pluginsTable)
          .where(eq(schema.pluginsTable.id, plugin.id)),
      ).toEqual([]);
      expect(
        await db
          .select({ id: schema.pluginFilesTable.id })
          .from(schema.pluginFilesTable)
          .where(eq(schema.pluginFilesTable.pluginId, plugin.id)),
      ).toEqual([]);

      const rows = await auditRows("plugin.purged", plugin.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].before).toMatchObject({ id: plugin.id });
      expect(JSON.stringify(rows[0].before)).not.toContain("Instructions");
    });

    test("removes the plugin's permission policy with it", async () => {
      const policies = (pluginId: string) =>
        db
          .select({ scope: schema.resourcePermissionPoliciesTable.scope })
          .from(schema.resourcePermissionPoliciesTable)
          .where(
            and(
              eq(schema.resourcePermissionPoliciesTable.resource, "plugin"),
              eq(schema.resourcePermissionPoliciesTable.scope, pluginId),
            ),
          );
      const plugin = await createPlugin("Shared, then gone");
      // Nothing ties the policy to the plugin's row, so no cascade reaches it.
      expect(await policies(plugin.id)).toHaveLength(1);
      expect((await del(plugin.id)).statusCode).toBe(200);
      // In the trash the policy is kept: a restore brings the access back.
      expect(await policies(plugin.id)).toHaveLength(1);

      expect((await purge(plugin.id)).statusCode).toBe(200);

      expect(await policies(plugin.id)).toEqual([]);
    });

    test("404s for a plugin that is still live", async () => {
      const plugin = await createPlugin("Still here");

      expect((await purge(plugin.id)).statusCode).toBe(404);
      expect(names(await list())).toEqual(["Still here"]);
    });

    test("404s for a custom role holding every plugin permission", async ({
      makeUser,
      makeCustomRole,
      makeMember,
    }) => {
      const plugin = await createPlugin("Guarded");
      expect((await del(plugin.id)).statusCode).toBe(200);
      // Permanent deletion takes a built-in admin role, not a permission.
      const role = await makeCustomRole(organizationId, {
        permission: { plugin: ["read", "create", "update", "delete"] },
      });
      const deleter = await makeUser();
      await makeMember(deleter.id, organizationId, { role: role.role });
      user = deleter;

      expect((await purge(plugin.id)).statusCode).toBe(404);
      expect(
        await PluginModel.findDeletedById({ id: plugin.id, organizationId }),
      ).not.toBeNull();
    });
  });
});
