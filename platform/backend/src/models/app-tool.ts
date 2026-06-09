import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { CredentialResolutionMode } from "@/types";
import type { InsertAppTool } from "@/types/app";

/**
 * Tool attachments for apps, mirroring `AgentToolModel` with the app as owner.
 * `isToolAllowed` is the per-app allowlist gate consulted (fail-closed) before
 * an app may call an upstream/assigned tool.
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

  /**
   * The assigned tool row (incl. `meta`) for a given name, or null if the tool
   * is not attached to this app. Mirrors `ToolModel.findByNameForAgent`; the app
   * MCP proxy uses it to enforce the per-app allowlist and the `_meta.ui`
   * visibility gate before a tools/call reaches execution.
   */
  static async findByNameForApp(
    appId: string,
    name: string,
  ): Promise<typeof schema.toolsTable.$inferSelect | null> {
    const [result] = await db
      .select({ tool: schema.toolsTable })
      .from(schema.appToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.appToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        and(
          eq(schema.appToolsTable.appId, appId),
          eq(schema.toolsTable.name, name),
        ),
      )
      .limit(1);
    return result?.tool ?? null;
  }

  /** Fail-closed allowlist check: is a tool with this name attached to the app? */
  static async isToolAllowed(
    appId: string,
    toolName: string,
  ): Promise<boolean> {
    const [match] = await db
      .select({ id: schema.appToolsTable.id })
      .from(schema.appToolsTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.appToolsTable.toolId, schema.toolsTable.id),
      )
      .where(
        and(
          eq(schema.appToolsTable.appId, appId),
          eq(schema.toolsTable.name, toolName),
        ),
      )
      .limit(1);
    return match !== undefined;
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
