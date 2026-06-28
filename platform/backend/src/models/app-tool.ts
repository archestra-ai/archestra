import { and, eq, notInArray } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type { CredentialResolutionMode } from "@/types";
import type { InsertAppTool } from "@/types/app";

/**
 * Tool attachments for apps, mirroring `AgentToolModel` with the app as owner.
 */
class AppToolModel {
  /** Tools attached to an app. */
  static async getToolsForApp(appId: string) {
    const results = await db
      .select({ tool: schema.toolsTable })
      .from(schema.appToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.appToolsTable.toolId, schema.toolsTable.id),
      )
      .where(eq(schema.appToolsTable.appId, appId));
    return results.map((r) => r.tool);
  }

  /** Full assignments (tool + resolution config) — what the app server needs to execute. */
  static async getAssignmentsForApp(appId: string) {
    return await db
      .select({
        tool: schema.toolsTable,
        mcpServerId: schema.appToolsTable.mcpServerId,
        credentialResolutionMode: schema.appToolsTable.credentialResolutionMode,
      })
      .from(schema.appToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.appToolsTable.toolId, schema.toolsTable.id),
      )
      .where(eq(schema.appToolsTable.appId, appId));
  }

  static async findToolIdsByApp(appId: string): Promise<string[]> {
    const results = await db
      .select({ toolId: schema.appToolsTable.toolId })
      .from(schema.appToolsTable)
      .where(eq(schema.appToolsTable.appId, appId));
    return results.map((r) => r.toolId);
  }

  /** Attach a tool to an app. */
  static async create(
    appId: string,
    toolId: string,
    options?: Partial<
      Pick<InsertAppTool, "mcpServerId" | "credentialResolutionMode">
    >,
  ) {
    const [appTool] = await db
      .insert(schema.appToolsTable)
      .values({
        appId,
        toolId,
        ...(options?.mcpServerId ? { mcpServerId: options.mcpServerId } : {}),
        ...(options?.credentialResolutionMode
          ? { credentialResolutionMode: options.credentialResolutionMode }
          : {}),
      })
      .returning();
    return appTool;
  }

  /**
   * Atomic upsert of an attachment's resolution config, mirroring
   * `AgentToolModel.createOrUpdateCredentials`. The insert uses
   * `onConflictDoUpdate` so concurrent assignments cannot violate the
   * `unique(appId, toolId)` constraint; the prior read distinguishes
   * created/updated/unchanged for the (non-racing) common case.
   */
  static async createOrUpdateCredentials(
    appId: string,
    toolId: string,
    mcpServerId?: string | null,
    credentialResolutionMode?: CredentialResolutionMode | null,
  ): Promise<{ status: "created" | "updated" | "unchanged" }> {
    const normalizedMcpServerId = mcpServerId ?? null;
    const normalizedMode = credentialResolutionMode ?? "static";

    const [existing] = await db
      .select({
        mcpServerId: schema.appToolsTable.mcpServerId,
        credentialResolutionMode: schema.appToolsTable.credentialResolutionMode,
      })
      .from(schema.appToolsTable)
      .where(
        and(
          eq(schema.appToolsTable.appId, appId),
          eq(schema.appToolsTable.toolId, toolId),
        ),
      )
      .limit(1);

    if (existing) {
      if (
        existing.mcpServerId === normalizedMcpServerId &&
        existing.credentialResolutionMode === normalizedMode
      ) {
        return { status: "unchanged" };
      }
    }

    await db
      .insert(schema.appToolsTable)
      .values({
        appId,
        toolId,
        mcpServerId: normalizedMcpServerId,
        credentialResolutionMode: normalizedMode,
      })
      .onConflictDoUpdate({
        target: [schema.appToolsTable.appId, schema.appToolsTable.toolId],
        set: {
          mcpServerId: normalizedMcpServerId,
          credentialResolutionMode: normalizedMode,
          updatedAt: new Date(),
        },
      });

    return { status: existing ? "updated" : "created" };
  }

  /**
   * Make the app's assignments exactly `assignments`, in one transaction:
   * tools not in the desired set are detached, the rest upserted. Callers
   * validate the tool list first — a failure mid-replace rolls everything
   * back, never leaving a partial set.
   */
  static async replaceAssignments(
    appId: string,
    assignments: ReadonlyArray<{
      toolId: string;
      mcpServerId: string | null;
      credentialResolutionMode: CredentialResolutionMode;
    }>,
  ): Promise<void> {
    await withDbTransaction(async (tx) => {
      // serialize concurrent replacements on the app row — without it two
      // racing calls interleave their delete+upsert phases and the final set
      // is a mix of both rather than either caller's list
      await tx
        .select({ id: schema.appsTable.id })
        .from(schema.appsTable)
        .where(eq(schema.appsTable.id, appId))
        .for("update");
      const keptToolIds = assignments.map((a) => a.toolId);
      await tx
        .delete(schema.appToolsTable)
        .where(
          and(
            eq(schema.appToolsTable.appId, appId),
            keptToolIds.length > 0
              ? notInArray(schema.appToolsTable.toolId, keptToolIds)
              : undefined,
          ),
        );
      for (const assignment of assignments) {
        await tx
          .insert(schema.appToolsTable)
          .values({
            appId,
            toolId: assignment.toolId,
            mcpServerId: assignment.mcpServerId,
            credentialResolutionMode: assignment.credentialResolutionMode,
          })
          .onConflictDoUpdate({
            target: [schema.appToolsTable.appId, schema.appToolsTable.toolId],
            set: {
              mcpServerId: assignment.mcpServerId,
              credentialResolutionMode: assignment.credentialResolutionMode,
              updatedAt: new Date(),
            },
          });
      }
    });
  }

  /** Detach a tool from an app. */
  static async delete(appId: string, toolId: string): Promise<boolean> {
    const rows = await db
      .delete(schema.appToolsTable)
      .where(
        and(
          eq(schema.appToolsTable.appId, appId),
          eq(schema.appToolsTable.toolId, toolId),
        ),
      )
      .returning({ id: schema.appToolsTable.id });
    return rows.length > 0;
  }
}

export default AppToolModel;
