// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertKbExternalGroup } from "@/types";

class KbExternalGroupModel {
  static async findByConnector(connectorId: string) {
    const t = schema.kbExternalGroupsTable;
    return await db
      .select()
      .from(t)
      .where(eq(t.connectorId, connectorId))
      .orderBy(t.name, t.groupId);
  }

  static async upsertMany(rows: InsertKbExternalGroup[]): Promise<number> {
    if (rows.length === 0) return 0;
    const result = await db
      .insert(schema.kbExternalGroupsTable)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          schema.kbExternalGroupsTable.connectorId,
          schema.kbExternalGroupsTable.groupId,
        ],
        set: {
          name: sql`excluded.name`,
          updatedAt: new Date(),
        },
        setWhere: sql`${schema.kbExternalGroupsTable.name} IS DISTINCT FROM excluded.name`,
      })
      .returning({ id: schema.kbExternalGroupsTable.id });
    return result.length;
  }

  static async deleteAbsent(params: {
    connectorId: string;
    seenGroupIds: string[];
  }): Promise<number> {
    const t = schema.kbExternalGroupsTable;
    const result = await db
      .delete(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          params.seenGroupIds.length > 0
            ? notInArray(t.groupId, params.seenGroupIds)
            : undefined,
        ),
      )
      .returning({ id: t.id });
    return result.length;
  }

  static async deleteByGroupIds(params: {
    connectorId: string;
    groupIds: string[];
  }): Promise<number> {
    if (params.groupIds.length === 0) return 0;
    const t = schema.kbExternalGroupsTable;
    const result = await db
      .delete(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          inArray(t.groupId, params.groupIds),
        ),
      )
      .returning({ id: t.id });
    return result.length;
  }
}

export default KbExternalGroupModel;
