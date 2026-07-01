import { and, asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { HookFile, InsertHookFile, UpdateHookFile } from "@/types/hook";
import { InsertHookFileSchema, UpdateHookFileSchema } from "@/types/hook";

class HookFileModel {
  static async create(data: InsertHookFile): Promise<HookFile> {
    const parsed = InsertHookFileSchema.parse(data);
    const [row] = await db
      .insert(schema.hookFilesTable)
      .values(parsed)
      .returning();
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

  static async listEnabledByAgent(
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
          eq(schema.hookFilesTable.enabled, true),
        ),
      )
      .orderBy(
        asc(schema.hookFilesTable.event),
        asc(schema.hookFilesTable.fileName),
      );
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
      .returning({ id: schema.hookFilesTable.id });
    return rows.length > 0;
  }
}

export default HookFileModel;
