// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { and, eq, inArray, or } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import ResourcePermissionPolicyModel from "./resource-permission-policy";

/**
 * Read-side accessibility for apps, decided by grants on the app, plus the
 * loaders for the retired team and user assignments on its backing catalog
 * (`apps → mcp_server → internal_mcp_catalog`).
 */
class AppAccessModel {
  /**
   * IDs of (non-deleted) apps a user can see: a read grant on the app, or at
   * `*`, decides. A disabled app is author-only regardless of grants — an
   * administrator sees every *enabled* app plus only their own disabled ones,
   * never someone else's work-in-progress. `userId: undefined` (a principal
   * with no user of its own) sees no apps; no grant names such a caller.
   */
  static async getUserAccessibleAppIds(params: {
    organizationId: string;
    userId?: string;
  }): Promise<string[]> {
    const { organizationId, userId } = params;
    if (userId === undefined) return [];
    const rows = await db
      .selectDistinct({ id: schema.appsTable.id })
      .from(schema.appsTable)
      // Only an app with its backing server is listed, as before.
      .innerJoin(
        schema.mcpServersTable,
        eq(schema.appsTable.mcpServerId, schema.mcpServersTable.id),
      )
      .innerJoin(
        schema.internalMcpCatalogTable,
        eq(schema.mcpServersTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .where(
        and(
          eq(schema.appsTable.organizationId, organizationId),
          notDeleted(schema.appsTable),
          or(
            eq(schema.appsTable.enabled, true),
            eq(schema.appsTable.authorId, userId),
          ),
          ResourcePermissionPolicyModel.grantCondition({
            organizationId,
            userId,
            resource: "app",
            scopeColumn: schema.appsTable.id,
            action: "read",
          }),
        ),
      );
    return rows.map((row) => row.id);
  }

  /**
   * Whether a user may view a specific app: a grant on the app (or at `*`)
   * decides. A disabled app is author-only regardless of grants.
   */
  static async userHasAppAccess(params: {
    organizationId: string;
    userId?: string;
    app: {
      id: string;
      organizationId: string;
      authorId: string | null;
      enabled: boolean;
    };
    action?: "read" | "use";
  }): Promise<boolean> {
    const { app, organizationId, userId } = params;
    if (app.organizationId !== organizationId) return false;
    if (!app.enabled && app.authorId !== userId) return false;
    if (!userId) return false;
    const [grant] = await db
      .select({ id: schema.appsTable.id })
      .from(schema.appsTable)
      .where(
        and(
          eq(schema.appsTable.id, app.id),
          ResourcePermissionPolicyModel.grantCondition({
            organizationId,
            userId,
            resource: "app",
            scopeColumn: schema.appsTable.id,
            action: params.action ?? "read",
          }),
        ),
      )
      .limit(1);
    return grant !== undefined;
  }

  /** The teams an app's own policy grants read to. */
  static async getTeamsForApp(appId: string): Promise<string[]> {
    const recipients = await ResourcePermissionPolicyModel.findReadRecipients({
      resources: ["app"],
      scopes: [appId],
    });
    return recipients.get(appId)?.teamIds ?? [];
  }

  /**
   * The people an app's own policy grants read to, other than its author,
   * for several apps. Backs the "shared with" list in App settings next to
   * {@link getTeamDetailsForApps}.
   */
  static async getUserDetailsForApps(
    appIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string; email: string }>>> {
    if (appIds.length === 0) return new Map();
    const authors = await db
      .select({ id: schema.appsTable.id, authorId: schema.appsTable.authorId })
      .from(schema.appsTable)
      .where(inArray(schema.appsTable.id, appIds));
    const details =
      await ResourcePermissionPolicyModel.findReadRecipientDetails({
        resources: ["app"],
        scopes: appIds,
        excludeUserIds: new Map(authors.map((row) => [row.id, row.authorId])),
      });
    return new Map(appIds.map((id) => [id, details.get(id)?.users ?? []]));
  }

  /** Team details (id + name) for {@link getTeamsForApp}, for several apps. */
  static async getTeamDetailsForApps(
    appIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const details =
      await ResourcePermissionPolicyModel.findReadRecipientDetails({
        resources: ["app"],
        scopes: appIds,
      });
    return new Map(
      appIds.map((id) => [
        id,
        (details.get(id)?.teams ?? []).map(({ id, name }) => ({ id, name })),
      ]),
    );
  }
}

export default AppAccessModel;
