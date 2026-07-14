// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { normalizeEmail } from "@/knowledge-base/acl-tokens";

/**
 * Admin-authored upstream-account → Archestra-user mappings for
 * `auto-sync-permissions` connectors. Written from the connector permissions
 * tab; read by the resolution joins in `KbExternalUserGroupModel`. Automatic
 * matching always takes precedence: a mapping only applies while the account
 * does not resolve through the email join.
 */
class KbMemberOverrideModel {
  /** Create or repoint the mapping for one upstream account. */
  static async upsert(params: {
    organizationId: string;
    connectorId: string;
    externalAccountId: string;
    userId: string;
  }): Promise<void> {
    await db
      .insert(schema.kbMemberOverridesTable)
      .values(params)
      .onConflictDoUpdate({
        target: [
          schema.kbMemberOverridesTable.connectorId,
          schema.kbMemberOverridesTable.externalAccountId,
        ],
        set: {
          userId: params.userId,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * All of a connector's mappings resolved to the mapped Archestra users'
   * normalized emails: `externalAccountId → email`. The permission pass loads
   * this once and threads it into the connector hooks so DIRECT grants (role
   * actors, user grants, reporter/assignee) to an account whose upstream
   * email is hidden materialize as the mapped user's email instead of being
   * dropped — group-derived access already honors mappings at query time.
   */
  static async findMappedEmailsByConnector(
    connectorId: string,
  ): Promise<Map<string, string>> {
    const o = schema.kbMemberOverridesTable;
    const rows = await db
      .select({
        externalAccountId: o.externalAccountId,
        email: schema.usersTable.email,
      })
      .from(o)
      .innerJoin(schema.usersTable, eq(schema.usersTable.id, o.userId))
      .where(eq(o.connectorId, connectorId));
    return new Map(
      rows
        .filter((row) => !!row.email)
        .map((row) => [row.externalAccountId, normalizeEmail(row.email)]),
    );
  }

  /** Remove the mapping for one upstream account; false when none existed. */
  static async deleteByConnectorAndAccount(params: {
    connectorId: string;
    externalAccountId: string;
  }): Promise<boolean> {
    // `.returning()` instead of `rowCount`: the PGlite test driver does not
    // report an accurate rowCount for deletes.
    const deletedRows = await db
      .delete(schema.kbMemberOverridesTable)
      .where(
        and(
          eq(schema.kbMemberOverridesTable.connectorId, params.connectorId),
          eq(
            schema.kbMemberOverridesTable.externalAccountId,
            params.externalAccountId,
          ),
        ),
      )
      .returning({ id: schema.kbMemberOverridesTable.id });
    return deletedRows.length > 0;
  }
}

export default KbMemberOverrideModel;
