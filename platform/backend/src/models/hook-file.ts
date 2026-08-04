import { and, asc, eq } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
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

  /**
   * Replace the agent's entire hook-file set atomically (hook identity is
   * `(event, fileName)`, not row id, so a full delete+insert is the correct
   * sync). Used by version restore, which replays a snapshot's hooks whole.
   */
  static async replaceForAgent(params: {
    agentId: string;
    organizationId: string;
    hooks: InsertHookFile[];
    /** See `AgentToolAssignmentRequest.deferVersionFork`. */
    deferVersionFork?: boolean;
  }): Promise<void> {
    const parsed = params.hooks.map((hook) => InsertHookFileSchema.parse(hook));
    await withDbTransaction(async (tx) => {
      await tx
        .delete(schema.hookFilesTable)
        .where(
          and(
            eq(schema.hookFilesTable.agentId, params.agentId),
            eq(schema.hookFilesTable.organizationId, params.organizationId),
          ),
        );
      if (parsed.length > 0) {
        await tx.insert(schema.hookFilesTable).values(parsed);
      }
    });
    if (!params.deferVersionFork) {
      await AgentVersionModel.forkIfChangedBestEffort(params.agentId);
    }
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
