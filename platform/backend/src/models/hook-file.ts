import { and, asc, count, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  HookEvent,
  HookFile,
  InsertHookFile,
  UpdateHookFile,
} from "@/types/hook";
import { InsertHookFileSchema, UpdateHookFileSchema } from "@/types/hook";
import AgentVersionModel from "./agent-version";

class HookFileModel {
  static async create(data: InsertHookFile): Promise<HookFile> {
    const parsed = InsertHookFileSchema.parse(data);
    const [row] = await db
      .insert(schema.hookFilesTable)
      .values(parsed)
      .returning();
    // Hooks are part of the agent config snapshot — fork a version.
    await AgentVersionModel.forkIfChangedBestEffort(row.agentId);
    return row;
  }

  /**
   * Insert a batch of hook files for ONE agent atomically: a single multi-row
   * INSERT, so any constraint violation (e.g. a duplicate `(agent, event,
   * file_name)` racing past the route's pre-check) applies nothing. The batch
   * is one user action — staged hooks flushed on agent create — so it forks a
   * single config version, not one per hook.
   */
  static async createMany(data: InsertHookFile[]): Promise<HookFile[]> {
    if (data.length === 0) return [];
    const parsed = data.map((d) => InsertHookFileSchema.parse(d));
    const agentIds = new Set(parsed.map((p) => p.agentId));
    if (agentIds.size !== 1) {
      throw new Error("createMany requires all hooks to target the same agent");
    }
    const rows = await db
      .insert(schema.hookFilesTable)
      .values(parsed)
      .returning();
    await AgentVersionModel.forkIfChangedBestEffort(parsed[0].agentId);
    return rows;
  }

  static async findById(
    id: string,
    organizationId: string,
  ): Promise<HookFile | null> {
    const [row] = await db
      .select()
      .from(schema.hookFilesTable)
      .where(
        and(
          eq(schema.hookFilesTable.id, id),
          eq(schema.hookFilesTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  static async listByAgent(
    agentId: string,
    organizationId: string,
  ): Promise<HookFile[]> {
    return await db
      .select()
      .from(schema.hookFilesTable)
      .where(
        and(
          eq(schema.hookFilesTable.agentId, agentId),
          eq(schema.hookFilesTable.organizationId, organizationId),
        ),
      )
      .orderBy(
        asc(schema.hookFilesTable.event),
        asc(schema.hookFilesTable.fileName),
      );
  }

  static async listEnabledByAgentAndEvent(params: {
    agentId: string;
    organizationId: string;
    event: HookEvent;
  }): Promise<HookFile[]> {
    return await db
      .select()
      .from(schema.hookFilesTable)
      .where(
        and(
          eq(schema.hookFilesTable.agentId, params.agentId),
          eq(schema.hookFilesTable.organizationId, params.organizationId),
          eq(schema.hookFilesTable.event, params.event),
          eq(schema.hookFilesTable.enabled, true),
        ),
      )
      .orderBy(asc(schema.hookFilesTable.fileName));
  }

  /**
   * Org-wide hook count snapshot for the audit log's before/after diff on
   * bulk creation (same shape as AgentToolModel.countAssignmentsForOrganization).
   */
  static async countForOrganization(
    organizationId: string,
  ): Promise<Record<string, unknown>> {
    const [row] = await db
      .select({ c: count() })
      .from(schema.hookFilesTable)
      .where(eq(schema.hookFilesTable.organizationId, organizationId));
    return { hookFileCount: Number(row?.c ?? 0) };
  }

  static async update(params: {
    id: string;
    organizationId: string;
    data: UpdateHookFile;
  }): Promise<HookFile | null> {
    const parsed = UpdateHookFileSchema.parse(params.data);
    const [row] = await db
      .update(schema.hookFilesTable)
      .set(parsed)
      .where(
        and(
          eq(schema.hookFilesTable.id, params.id),
          eq(schema.hookFilesTable.organizationId, params.organizationId),
        ),
      )
      .returning();
    if (row) {
      await AgentVersionModel.forkIfChangedBestEffort(row.agentId);
    }
    return row ?? null;
  }

  static async delete(id: string, organizationId: string): Promise<boolean> {
    const rows = await db
      .delete(schema.hookFilesTable)
      .where(
        and(
          eq(schema.hookFilesTable.id, id),
          eq(schema.hookFilesTable.organizationId, organizationId),
        ),
      )
      // agentId is needed to fork the owning agent's config version.
      .returning({
        id: schema.hookFilesTable.id,
        agentId: schema.hookFilesTable.agentId,
      });
    if (rows.length > 0) {
      await AgentVersionModel.forkIfChangedBestEffort(rows[0].agentId);
    }
    return rows.length > 0;
  }
}

export default HookFileModel;
