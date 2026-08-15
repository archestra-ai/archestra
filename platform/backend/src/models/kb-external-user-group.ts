// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { and, count, eq, inArray, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import db, { schema } from "@/database";
import { buildGroupToken, normalizeEmail } from "@/knowledge-base/acl-tokens";
import type {
  AclEntry,
  ConnectorType,
  InsertKbExternalUserGroup,
} from "@/types";

/**
 * Snapshot of upstream group memberships for `auto-sync-permissions` connectors.
 * The permission-sync pass owns writes here via the mark-stale → upsert →
 * delete-stale cycle; the query path reads it (local join, no upstream call) to
 * resolve a user's `group:` tokens.
 */
class KbExternalUserGroupModel {
  /**
   * Lean projection of the current membership snapshot for one connector,
   * used by the permission pass to diff the fresh enumeration against what is
   * stored — unchanged memberships then cost ZERO writes (the retired
   * mark-stale cycle rewrote every row every pass).
   */
  static async findMembershipSnapshotByConnector(connectorId: string): Promise<
    {
      groupId: string;
      externalAccountId: string;
      memberEmail: string | null;
      displayName: string | null;
      accountType: string | null;
    }[]
  > {
    const t = schema.kbExternalUserGroupsTable;
    return await db
      .select({
        groupId: t.groupId,
        externalAccountId: t.externalAccountId,
        memberEmail: t.memberEmail,
        displayName: t.displayName,
        accountType: t.accountType,
      })
      .from(t)
      .where(eq(t.connectorId, connectorId));
  }

  static async findMembershipSnapshotByGroups(params: {
    connectorId: string;
    groupIds: string[];
  }): Promise<
    {
      groupId: string;
      externalAccountId: string;
      memberEmail: string | null;
      displayName: string | null;
      accountType: string | null;
    }[]
  > {
    if (params.groupIds.length === 0) return [];
    const t = schema.kbExternalUserGroupsTable;
    return await db
      .select({
        groupId: t.groupId,
        externalAccountId: t.externalAccountId,
        memberEmail: t.memberEmail,
        displayName: t.displayName,
        accountType: t.accountType,
      })
      .from(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          inArray(t.groupId, params.groupIds),
        ),
      );
  }

  static async deleteByGroupIds(params: {
    connectorId: string;
    groupIds: string[];
  }): Promise<number> {
    if (params.groupIds.length === 0) return 0;
    const t = schema.kbExternalUserGroupsTable;
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

  /**
   * Upsert a batch of new or CHANGED memberships (the pass diffs first, so
   * unchanged rows never reach this). A re-upsert refreshes the email/display
   * name, so a member whose email BECOMES visible upstream starts resolving
   * on the next pass.
   */
  /**
   * @param fence The run these memberships belong to. The write is skipped
   *   unless that run is still `running` at the given lease epoch. Membership
   *   is the second route into a document: a `group:` token here is matched
   *   against container audiences by `findContainerTokensForUser`, so a pass
   *   whose lease was reclaimed could otherwise put a removed member back into
   *   a group and restore their read access without touching an ACL row.
   * @returns whether the rows were written.
   */
  static async upsertMany(
    rows: InsertKbExternalUserGroup[],
    fence?: { runId: string; epoch: number },
  ): Promise<boolean> {
    if (rows.length === 0) return true;

    const values = rows.map((row) => ({
      ...row,
      memberEmail: row.memberEmail ? normalizeEmail(row.memberEmail) : null,
    }));

    if (!fence) {
      await db
        .insert(schema.kbExternalUserGroupsTable)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.kbExternalUserGroupsTable.connectorId,
            schema.kbExternalUserGroupsTable.groupId,
            schema.kbExternalUserGroupsTable.externalAccountId,
          ],
          set: {
            stale: false,
            memberEmail: sql`excluded.member_email`,
            displayName: sql`excluded.display_name`,
            accountType: sql`excluded.account_type`,
            updatedAt: new Date(),
          },
        });
      return true;
    }

    // One statement, for the same reason the container fence is one: this runs
    // once per batch across a whole roster, and the ownership test belongs in
    // the write's own snapshot rather than a transaction around it.
    const tuples = sql.join(
      values.map(
        (row) =>
          sql`(${row.organizationId}, ${row.connectorId}::uuid, ${row.connectorType}, ${row.groupId}, ${row.externalAccountId}, ${row.displayName ?? null}, ${row.memberEmail ?? null}, ${row.accountType ?? null})`,
      ),
      sql`, `,
    );
    const result = await db.execute(sql`
      INSERT INTO kb_external_user_groups
        (organization_id, connector_id, connector_type, group_id,
         external_account_id, display_name, member_email, account_type,
         stale, updated_at)
      SELECT v.organization_id, v.connector_id, v.connector_type, v.group_id,
             v.external_account_id, v.display_name, v.member_email,
             v.account_type, false, now()
      FROM (VALUES ${tuples})
        AS v(organization_id, connector_id, connector_type, group_id,
             external_account_id, display_name, member_email, account_type)
      WHERE EXISTS (
        SELECT 1 FROM connector_runs
        WHERE id = ${fence.runId}::uuid
          AND status = 'running'
          AND lease_epoch = ${fence.epoch}
      )
      ON CONFLICT (connector_id, group_id, external_account_id) DO UPDATE SET
        stale = false,
        member_email = excluded.member_email,
        display_name = excluded.display_name,
        account_type = excluded.account_type,
        updated_at = now()
      RETURNING id
    `);
    const written = Array.isArray(result) ? result : (result.rows ?? []);
    return written.length > 0;
  }

  /**
   * Delete an explicit batch of revoked memberships (present in the stored
   * snapshot, absent from a COMPLETED enumeration — completion-gated by the
   * caller, so an interrupted run never wrongly drops a membership).
   */
  static async deleteByKeys(params: {
    connectorId: string;
    keys: { groupId: string; externalAccountId: string }[];
  }): Promise<number> {
    if (params.keys.length === 0) return 0;

    const t = schema.kbExternalUserGroupsTable;
    const tuples = sql.join(
      params.keys.map((key) => sql`(${key.groupId}, ${key.externalAccountId})`),
      sql`, `,
    );
    // RETURNING-based count: `rowCount` is driver-dependent (absent under the
    // PGlite test driver), and the caller reports this number as the pass's
    // membershipsRemoved stat.
    const result = await db
      .delete(schema.kbExternalUserGroupsTable)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          sql`(${t.groupId}, ${t.externalAccountId}) IN (${tuples})`,
        ),
      )
      .returning({ groupId: t.groupId });
    return result.length;
  }

  /**
   * Resolve the namespaced `group:` tokens a user is entitled to, across the
   * given auto-sync connectors, via a local join on member email (no upstream
   * call on the query hot path). The email is normalized to match the stored
   * `memberEmail`. Automatic matching always takes precedence: a manual
   * member override grants the membership's groups ONLY while the upstream
   * account does not resolve automatically — no user in the connector's org
   * carries the member's email (hidden email, or no matching account).
   */
  static async findGroupTokensForUser(params: {
    memberEmail: string;
    userId?: string;
    connectorIds: string[];
  }): Promise<AclEntry[]> {
    if (params.connectorIds.length === 0) return [];

    const t = schema.kbExternalUserGroupsTable;
    // The two grant paths are queried separately rather than OR'd into one
    // WHERE. Under an OR, Postgres cannot push the override's `user_id = $1`
    // guard into the membership scan (it belongs to the outer-joined table),
    // so it pushes down `member_email = $1 OR NOT EXISTS(<autoMatch>)` and
    // runs the correlated subquery once per membership row in the snapshot —
    // measured at 5002 executions and 2.7s on a 5k-membership connector.
    // Split, each path is driven by its own index and the correlation only
    // ever runs over this user's handful of overrides.
    const auto = await db
      .selectDistinct({
        connectorType: t.connectorType,
        groupId: t.groupId,
      })
      .from(t)
      .where(
        and(
          inArray(t.connectorId, params.connectorIds),
          eq(t.memberEmail, normalizeEmail(params.memberEmail)),
        ),
      );

    const overridden = params.userId
      ? await KbExternalUserGroupModel.findGroupsViaMemberOverride({
          userId: params.userId,
          connectorIds: params.connectorIds,
        })
      : [];

    return [
      ...new Set(
        [...auto, ...overridden].map((row) =>
          buildGroupToken({
            connectorType: row.connectorType,
            groupId: row.groupId,
          }),
        ),
      ),
    ];
  }

  /** Membership rows stored for a connector (group × account pairs). */
  static async countByConnector(connectorId: string): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(schema.kbExternalUserGroupsTable)
      .where(eq(schema.kbExternalUserGroupsTable.connectorId, connectorId));
    return row?.value ?? 0;
  }

  /**
   * The membership snapshot for a connector, each row annotated with the
   * Archestra org member it resolves to at query time. Resolution is the same
   * join `findGroupTokensForUser` enforces with — the normalized-email join
   * first (automatic matching always wins), a manual member override only as
   * the fallback — so what this reports is exactly what access control does:
   * `user` is null when neither an org member's email nor an override matches
   * (including when the upstream hides the email — `memberEmail` null), and
   * the grant currently resolves to nobody.
   *
   * Bounded by `limit`, and says so. Membership rows are group × account, so a
   * Confluence instance where most people are in most groups holds far more of
   * them than it has users — and this is the widest query in the feature (five
   * left joins). Unbounded, the size of one customer's directory decides how
   * much memory the admin tab costs, in the model, in the route that nests it,
   * and again in the JSON it serializes.
   */
  static async findMembershipsWithUsersByConnector(params: {
    connectorId: string;
    organizationId: string;
    limit: number;
  }): Promise<{
    memberships: {
      groupId: string;
      externalAccountId: string;
      displayName: string | null;
      memberEmail: string | null;
      accountType: string | null;
      updatedAt: Date;
      /** Email included so every surface can render the resolved identity. */
      user: { id: string; name: string; email: string } | null;
      /** How `user` resolved: manual admin mapping or the email join. */
      resolvedVia: "override" | "email" | null;
    }[];
    /** More rows exist than were returned — the member lists are partial. */
    truncated: boolean;
  }> {
    const t = schema.kbExternalUserGroupsTable;
    const o = schema.kbMemberOverridesTable;
    const overrideUsers = alias(schema.usersTable, "override_users");
    const overrideMembers = alias(schema.membersTable, "override_members");
    const rows = await db
      .select({
        groupId: t.groupId,
        externalAccountId: t.externalAccountId,
        displayName: t.displayName,
        memberEmail: t.memberEmail,
        accountType: t.accountType,
        updatedAt: t.updatedAt,
        userId: schema.usersTable.id,
        userName: schema.usersTable.name,
        userEmail: schema.usersTable.email,
        memberId: schema.membersTable.id,
        overrideUserId: overrideUsers.id,
        overrideUserName: overrideUsers.name,
        overrideUserEmail: overrideUsers.email,
        overrideMemberId: overrideMembers.id,
      })
      .from(t)
      .leftJoin(
        schema.usersTable,
        // Same lower(trim(...)) = normalizeEmail contract as
        // findGroupTokensForUser — the listing must resolve exactly like the
        // query path or the Users tab would disagree with actual access.
        sql`lower(trim(${schema.usersTable.email})) = ${t.memberEmail}`,
      )
      .leftJoin(
        schema.membersTable,
        and(
          eq(schema.membersTable.userId, schema.usersTable.id),
          eq(schema.membersTable.organizationId, params.organizationId),
        ),
      )
      .leftJoin(
        o,
        and(
          eq(o.connectorId, t.connectorId),
          eq(o.externalAccountId, t.externalAccountId),
        ),
      )
      .leftJoin(overrideUsers, eq(overrideUsers.id, o.userId))
      .leftJoin(
        overrideMembers,
        and(
          eq(overrideMembers.userId, overrideUsers.id),
          eq(overrideMembers.organizationId, params.organizationId),
        ),
      )
      .where(eq(t.connectorId, params.connectorId))
      .orderBy(t.groupId, t.memberEmail, t.externalAccountId)
      // One past the limit, so "there are more" is known without a second query.
      .limit(params.limit + 1);

    const truncated = rows.length > params.limit;
    const memberships = (truncated ? rows.slice(0, params.limit) : rows).map(
      (row) => {
        // A matching user account only counts if it is a member of this org —
        // for the override exactly as for the email join, so an override to a
        // since-departed user reads (and enforces) as unresolved.
        const overrideUser =
          row.overrideMemberId &&
          row.overrideUserId &&
          row.overrideUserName !== null
            ? {
                id: row.overrideUserId,
                name: row.overrideUserName,
                email: row.overrideUserEmail ?? "",
              }
            : null;
        const emailUser =
          row.memberId && row.userId && row.userName !== null
            ? { id: row.userId, name: row.userName, email: row.userEmail ?? "" }
            : null;
        return {
          groupId: row.groupId,
          externalAccountId: row.externalAccountId,
          displayName: row.displayName,
          memberEmail: row.memberEmail,
          accountType: row.accountType,
          updatedAt: row.updatedAt,
          user: emailUser ?? overrideUser,
          resolvedVia: (emailUser
            ? "email"
            : overrideUser
              ? "override"
              : null) as "override" | "email" | null,
        };
      },
    );
    return { memberships, truncated };
  }

  static async deleteByConnector(connectorId: string): Promise<number> {
    const result = await db
      .delete(schema.kbExternalUserGroupsTable)
      .where(eq(schema.kbExternalUserGroupsTable.connectorId, connectorId));
    return result.rowCount ?? 0;
  }

  /**
   * Groups granted to a user by an admin's manual member override — the
   * fallback path, live ONLY while the upstream account does not resolve
   * automatically (no user in the connector's organization carries the
   * account's email). Driven by the override table, so the "does it resolve
   * automatically" correlation runs over this user's overrides (a handful)
   * rather than the whole membership snapshot.
   */
  private static async findGroupsViaMemberOverride(params: {
    userId: string;
    connectorIds: string[];
  }): Promise<{ connectorType: ConnectorType; groupId: string }[]> {
    const t = schema.kbExternalUserGroupsTable;
    const o = schema.kbMemberOverridesTable;
    const c = schema.knowledgeBaseConnectorsTable;

    // Does the overridden account's email already belong to an org member of
    // the connector's organization? While it does, automatic matching wins and
    // the override is inert.
    const autoMatch = db
      .select({ one: sql`1` })
      .from(schema.usersTable)
      .innerJoin(
        schema.membersTable,
        eq(schema.membersTable.userId, schema.usersTable.id),
      )
      .innerJoin(c, eq(c.id, t.connectorId))
      .where(
        and(
          // lower(trim(...)) mirrors normalizeEmail (which produced the
          // stored memberEmail), so the comparison cannot diverge from the
          // write-side contract.
          sql`lower(trim(${schema.usersTable.email})) = ${t.memberEmail}`,
          eq(schema.membersTable.organizationId, c.organizationId),
        ),
      );

    return await db
      .selectDistinct({
        connectorType: t.connectorType,
        groupId: t.groupId,
      })
      .from(o)
      .innerJoin(
        t,
        and(
          eq(t.connectorId, o.connectorId),
          eq(t.externalAccountId, o.externalAccountId),
        ),
      )
      .where(
        and(
          eq(o.userId, params.userId),
          inArray(o.connectorId, params.connectorIds),
          notExists(autoMatch),
        ),
      );
  }
}

export default KbExternalUserGroupModel;
