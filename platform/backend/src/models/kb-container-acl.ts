// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { and, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { buildContainerToken } from "@/knowledge-base/acl-tokens";
import type { AclEntry, InsertKbContainerAcl } from "@/types";

/**
 * Materialized audiences of upstream permission containers for
 * `auto-sync-permissions` connectors. The permission-sync pass owns writes
 * here via the mark-stale → upsert → sweep cycle; the query path reads it
 * (local join, no upstream call) to expand a user's base tokens into the
 * `container:` tokens they can read.
 *
 * Writes carry a run fence. A container row is not inert: `container:` tokens
 * on documents are fenced against a *visibility* switch, but which principals
 * a token expands for is decided here, by `findContainerTokensForUser`
 * matching a user's base tokens against `acl`. So a writer whose run was
 * reclaimed — a worker resuming from a freeze, or one superseded by a settings
 * edit — can restore a revoked principal's read access to every document
 * holding that container's token, without touching a single document row.
 * `fence` makes those writes no-ops.
 */
class KbContainerAclModel {
  /**
   * Mark every container row for a connector stale, ahead of a fresh
   * `syncContainerAudiences()` enumeration. Live containers clear the flag on
   * re-upsert; whatever stays stale after enumeration finishes was deleted
   * upstream. Query-time resolution ignores the flag.
   */
  static async markStaleByConnector(connectorId: string): Promise<number> {
    const result = await db
      .update(schema.kbContainerAclsTable)
      .set({ stale: true })
      .where(eq(schema.kbContainerAclsTable.connectorId, connectorId));
    return result.rowCount ?? 0;
  }

  /**
   * @param fence The run these rows belong to. The write is skipped unless
   *   that run is still `running` at the given lease epoch, so a pass whose
   *   lease was reclaimed cannot write an audience it computed before it lost
   *   ownership. Omitted only by callers that are not a permission pass.
   * @returns whether the rows were written.
   */
  static async upsertMany(
    rows: InsertKbContainerAcl[],
    fence?: { runId: string; epoch: number },
  ): Promise<boolean> {
    if (rows.length === 0) return true;

    if (!fence) {
      await db
        .insert(schema.kbContainerAclsTable)
        .values(rows)
        .onConflictDoUpdate({
          target: [
            schema.kbContainerAclsTable.connectorId,
            schema.kbContainerAclsTable.containerKey,
          ],
          set: {
            stale: false,
            acl: sql`excluded.acl`,
            fingerprint: sql`excluded.fingerprint`,
            updatedAt: new Date(),
          },
        });
      return true;
    }

    // One statement, not a transaction around a read: the full enumeration
    // writes containers one at a time, so a BEGIN/SELECT/INSERT/COMMIT per
    // container would triple the round trips on the write-hot path. `EXISTS`
    // is evaluated in the same statement's snapshot, which is exactly the
    // atomicity the fence needs — if the run is no longer ours, the SELECT
    // feeding the INSERT yields no rows and nothing is written.
    const values = sql.join(
      rows.map(
        (row) =>
          sql`(${row.organizationId}, ${row.connectorId}::uuid, ${row.containerKey}, ${JSON.stringify(row.acl ?? [])}::jsonb, ${row.fingerprint ?? null})`,
      ),
      sql`, `,
    );
    const result = await db.execute(sql`
      INSERT INTO kb_container_acls
        (organization_id, connector_id, container_key, acl, fingerprint, stale, updated_at)
      SELECT v.organization_id, v.connector_id, v.container_key, v.acl, v.fingerprint, false, now()
      FROM (VALUES ${values})
        AS v(organization_id, connector_id, container_key, acl, fingerprint)
      WHERE EXISTS (
        SELECT 1 FROM connector_runs
        WHERE id = ${fence.runId}::uuid
          AND status = 'running'
          AND lease_epoch = ${fence.epoch}
      )
      ON CONFLICT (connector_id, container_key) DO UPDATE SET
        stale = false,
        acl = excluded.acl,
        fingerprint = excluded.fingerprint,
        updated_at = now()
      RETURNING id
    `);
    // Counted from RETURNING rather than a driver's rowCount, which is not
    // reported uniformly across the drivers this runs on. Zero rows can only
    // mean the fence rejected the write: `rows` is non-empty and every conflict
    // is an UPDATE, which still returns.
    const written = Array.isArray(result) ? result : (result.rows ?? []);
    return written.length > 0;
  }

  /**
   * Delete the container rows still stale after a completed enumeration — the
   * containers deleted upstream. Dropping a row instantly fail-closes every
   * document still holding its `container:` token, with zero document writes.
   * Called only once enumeration finishes (completion-gated).
   */
  static async sweepStaleByConnector(connectorId: string): Promise<number> {
    const result = await db
      .delete(schema.kbContainerAclsTable)
      .where(
        and(
          eq(schema.kbContainerAclsTable.connectorId, connectorId),
          eq(schema.kbContainerAclsTable.stale, true),
        ),
      );
    return result.rowCount ?? 0;
  }

  /**
   * The container rows still stale after an end-to-end enumeration — the
   * containers deleted upstream. The pass fail-closes their documents before
   * sweeping the rows.
   */
  static async findStaleByConnector(
    connectorId: string,
  ): Promise<{ containerKey: string }[]> {
    return await db
      .select({ containerKey: schema.kbContainerAclsTable.containerKey })
      .from(schema.kbContainerAclsTable)
      .where(
        and(
          eq(schema.kbContainerAclsTable.connectorId, connectorId),
          eq(schema.kbContainerAclsTable.stale, true),
        ),
      );
  }

  /**
   * Every stored container key for a connector, ordered — the input of the
   * audience-refresh pass (re-resolve each stored audience without touching
   * documents).
   */
  static async findKeysByConnector(connectorId: string): Promise<string[]> {
    const rows = await db
      .select({ containerKey: schema.kbContainerAclsTable.containerKey })
      .from(schema.kbContainerAclsTable)
      .where(eq(schema.kbContainerAclsTable.connectorId, connectorId))
      .orderBy(schema.kbContainerAclsTable.containerKey);
    return rows.map((row) => row.containerKey);
  }

  /** Full cleanup when a connector leaves `auto-sync-permissions` or is deleted. */
  static async deleteByConnector(connectorId: string): Promise<number> {
    const result = await db
      .delete(schema.kbContainerAclsTable)
      .where(eq(schema.kbContainerAclsTable.connectorId, connectorId));
    return result.rowCount ?? 0;
  }

  /**
   * Resolve the `container:` tokens a user is entitled to across the given
   * auto-sync connectors: containers whose materialized audience overlaps the
   * user's base tokens (`org:*` for public containers, `user_email:` for
   * direct grants, `group:` for group grants — resolve group tokens FIRST and
   * pass them in). Local jsonb-overlap query, no upstream call.
   */
  static async findContainerTokensForUser(params: {
    connectorIds: string[];
    baseTokens: AclEntry[];
  }): Promise<AclEntry[]> {
    if (params.connectorIds.length === 0 || params.baseTokens.length === 0) {
      return [];
    }

    const t = schema.kbContainerAclsTable;
    const tokenList = sql.join(
      params.baseTokens.map((token) => sql`${token}`),
      sql`, `,
    );
    const rows = await db
      .select({ connectorId: t.connectorId, containerKey: t.containerKey })
      .from(t)
      .where(
        and(
          inArray(t.connectorId, params.connectorIds),
          sql`${t.acl} ?| ARRAY[${tokenList}]`,
        ),
      );

    return rows.map((row) =>
      buildContainerToken({
        connectorId: row.connectorId,
        containerKey: row.containerKey,
      }),
    );
  }

  /**
   * Audiences for a batch of container keys of one connector, keyed by
   * container key. Used to expand a document's `container:` token back into
   * the effective audience for display (ACL badges).
   */
  static async findAudiencesByKeys(params: {
    connectorId: string;
    containerKeys: string[];
  }): Promise<Map<string, AclEntry[]>> {
    if (params.containerKeys.length === 0) return new Map();

    const t = schema.kbContainerAclsTable;
    const rows = await db
      .select({ containerKey: t.containerKey, acl: t.acl })
      .from(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          inArray(t.containerKey, params.containerKeys),
        ),
      );
    return new Map(
      rows.map((row) => [row.containerKey, row.acl as AclEntry[]]),
    );
  }

  /**
   * The full stored state of a batch of container rows — audience, fingerprint
   * and stale flag — which is exactly what the pass needs to decide whether a
   * re-resolved audience is worth writing. `stale` rides along because a row
   * marked by a full pass MUST be re-upserted even when its audience is
   * unchanged: the upsert is what clears the mark, and an uncleared mark gets
   * the container swept as vanished.
   */
  static async findAudienceStateByKeys(params: {
    connectorId: string;
    containerKeys: string[];
  }): Promise<
    Map<string, { acl: AclEntry[]; fingerprint: string | null; stale: boolean }>
  > {
    if (params.containerKeys.length === 0) return new Map();

    const t = schema.kbContainerAclsTable;
    const rows = await db
      .select({
        containerKey: t.containerKey,
        acl: t.acl,
        fingerprint: t.fingerprint,
        stale: t.stale,
      })
      .from(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          inArray(t.containerKey, params.containerKeys),
        ),
      );
    return new Map(
      rows.map((row) => [
        row.containerKey,
        {
          acl: row.acl as AclEntry[],
          fingerprint: row.fingerprint,
          stale: row.stale,
        },
      ]),
    );
  }
}

export default KbContainerAclModel;
