import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  isServiceAccountUserId,
  SERVICE_ACCOUNT_USER_ID_PREFIX,
} from "@/auth/service-account-user-id";
import db, { schema } from "@/database";
import {
  type CursorPaginatedResult,
  createCursorPaginatedResult,
  createPaginatedResult,
  decodeCursor,
  type PaginatedResult,
} from "@/database/utils/pagination";
import { auditLogExporter } from "@/observability/audit-log-export";
import type {
  AuditActorType,
  AuditEventName,
  AuditLog,
  AuditLogWithImpersonator,
  AuditOutcome,
  InsertAuditLog,
  SortDirection,
} from "@/types";

function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function buildSearchCondition(search: string) {
  const trimmed = search.trim();
  if (!trimmed) return undefined;
  const pattern = `%${escapeLikePattern(trimmed)}%`;
  return or(
    ilike(schema.auditLogsTable.actorEmail, pattern),
    ilike(schema.auditLogsTable.actorName, pattern),
    ilike(schema.auditLogsTable.httpPath, pattern),
    ilike(schema.auditLogsTable.resourceId, pattern),
    ilike(schema.auditLogsTable.resourceName, pattern),
  );
}

/** Self-join alias: resolve the impersonator's email for display. */
const impersonatorUsers = alias(schema.usersTable, "impersonator_users");

class AuditLogModel {
  static async create(input: InsertAuditLog): Promise<AuditLog> {
    const [row] = await db
      .insert(schema.auditLogsTable)
      .values(input)
      .returning();
    auditLogExporter.export(row);
    return row;
  }

  static async findById(
    id: string,
    organizationId: string,
  ): Promise<AuditLogWithImpersonator | null> {
    const [row] = await db
      .select({
        ...getTableColumns(schema.auditLogsTable),
        impersonatedByEmail: impersonatorUsers.email,
      })
      .from(schema.auditLogsTable)
      .leftJoin(
        impersonatorUsers,
        eq(schema.auditLogsTable.impersonatedBy, impersonatorUsers.id),
      )
      .where(
        and(
          eq(schema.auditLogsTable.id, id),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    return (row as AuditLogWithImpersonator | undefined) ?? null;
  }

  static async findPaginated(opts: {
    organizationId: string;
    limit: number;
    offset: number;
    sortDirection?: SortDirection;
    startDate?: Date;
    endDate?: Date;
    actorId?: string;
    action?: AuditEventName;
    outcome?: AuditOutcome;
    actorType?: AuditActorType;
    resourceType?: string;
    resourceId?: string;
    search?: string;
  }): Promise<PaginatedResult<AuditLogWithImpersonator>> {
    const { limit, offset, sortDirection = "desc" } = opts;

    const whereClause = and(...AuditLogModel.buildFilterConditions(opts));
    const orderBy = AuditLogModel.buildOrderBy(sortDirection);

    const [data, [{ total }]] = await Promise.all([
      db
        .select({
          ...getTableColumns(schema.auditLogsTable),
          // Human-readable attribution for rows written during impersonation
          // (impersonatedBy alone is an opaque user id). Null when the row is
          // not impersonation-attributed or the impersonator was deleted.
          impersonatedByEmail: impersonatorUsers.email,
        })
        .from(schema.auditLogsTable)
        .leftJoin(
          impersonatorUsers,
          eq(schema.auditLogsTable.impersonatedBy, impersonatorUsers.id),
        )
        .where(whereClause)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(schema.auditLogsTable)
        .where(whereClause),
    ]);

    return createPaginatedResult(
      data as AuditLogWithImpersonator[],
      Number(total),
      {
        limit,
        offset,
      },
    );
  }

  /**
   * The same listing, walked by cursor instead of offset.
   *
   * Two costs disappear. There is no `count()`, so a page no longer scans
   * every row in the organization to render a page number nobody navigates
   * by. And there is no offset, so page one thousand costs what page one
   * costs — the keyset predicate seeks straight to the position and reads
   * `limit + 1` rows, where an offset would have read and thrown away
   * everything above it.
   *
   * `(created_at, event_sequence)` is the key. `event_sequence` is a
   * postgres-assigned bigserial, so the pair is strictly ordered and unique
   * even when many rows share a timestamp, and the existing index covers it.
   */
  static async findCursorPaginated(opts: {
    organizationId: string;
    limit: number;
    cursor?: string;
    startDate?: Date;
    endDate?: Date;
    actorId?: string;
    action?: AuditEventName;
    outcome?: AuditOutcome;
    actorType?: AuditActorType;
    resourceType?: string;
    resourceId?: string;
  }): Promise<CursorPaginatedResult<AuditLogWithImpersonator>> {
    const { limit, cursor } = opts;

    const conditions = AuditLogModel.buildFilterConditions(opts);

    // An unreadable cursor is treated as no cursor, so a stale or truncated
    // link lands on the newest page instead of erroring.
    const position = decodeCursor(cursor);
    if (position) {
      const at = new Date(position.value);
      const seq = Number(position.id);
      if (!Number.isNaN(at.getTime()) && Number.isFinite(seq)) {
        // Row comparison, not two ANDed predicates: `(a, b) < (x, y)` is one
        // ordered comparison the planner can drive the composite index from.
        const keyset = sql`(${schema.auditLogsTable.createdAt}, ${schema.auditLogsTable.eventSequence})`;
        conditions.push(
          sql`${keyset} < (${position.value}::timestamptz, ${seq})`,
        );
      }
    }

    const rows = await db
      .select({
        ...getTableColumns(schema.auditLogsTable),
        impersonatedByEmail: impersonatorUsers.email,
      })
      .from(schema.auditLogsTable)
      .leftJoin(
        impersonatorUsers,
        eq(schema.auditLogsTable.impersonatedBy, impersonatorUsers.id),
      )
      .where(and(...conditions))
      .orderBy(
        desc(schema.auditLogsTable.createdAt),
        desc(schema.auditLogsTable.eventSequence),
      )
      // One more than the page needs: its presence is what answers "is there
      // another page", replacing the count this method no longer runs.
      .limit(limit + 1);

    return createCursorPaginatedResult(
      rows as AuditLogWithImpersonator[],
      { limit, cursor },
      (row) => ({
        value: row.createdAt.toISOString(),
        id: String(row.eventSequence),
      }),
    );
  }

  /**
   * Resources that have audit events, each with the name of its latest named
   * event, for the log's resource filter. Deleted resources stay listed. A
   * caller scoped to its own events (`actorId`) only sees names from those
   * events, so this exposes no name the log itself would not show.
   */
  static async findResourceOptions(opts: {
    organizationId: string;
    resourceTypes: readonly string[];
    actorId?: string;
    search?: string;
    resourceId?: string;
    limit: number;
  }): Promise<
    Array<{
      resourceType: string;
      resourceId: string;
      name: string;
      detail: string | null;
    }>
  > {
    if (opts.resourceTypes.length === 0) return [];
    const types = sql.join(
      opts.resourceTypes.map((type) => sql`(${type}::text)`),
      sql`, `,
    );
    const table = schema.auditLogsTable;
    // A skip scan: Postgres cannot jump between distinct keys of an index on
    // its own, so a plain DISTINCT ON reads every event of these types. The
    // recursive walk seeks once per resource instead (each step an index-only
    // probe on audit_logs_org_resource_latest_idx), so the cost follows the
    // number of resources, not the number of events.
    // One known resource, or a caller scoped to its own events (enumerated
    // from the actor index, bounded by what they did), skip the walk.
    const resources =
      opts.resourceId || opts.actorId
        ? sql`
        SELECT DISTINCT resource_type, resource_id
        FROM ${table}
        WHERE organization_id = ${opts.organizationId}
          AND resource_type IN (SELECT resource_type FROM types)
          AND resource_id IS NOT NULL
          ${opts.resourceId ? sql`AND resource_id = ${opts.resourceId}` : sql``}
          ${opts.actorId ? sql`AND actor_id = ${opts.actorId}` : sql``}`
        : sql`
        SELECT resource_type, resource_id FROM walk`;
    const result = await db.execute<{
      resource_type: string;
      resource_id: string;
      resource_name: string;
    }>(sql`
      WITH RECURSIVE types(resource_type) AS (VALUES ${types}),
      walk(resource_type, resource_id) AS (
        SELECT types.resource_type, first.resource_id
        FROM types
        CROSS JOIN LATERAL (
          SELECT resource_id FROM ${table}
          WHERE organization_id = ${opts.organizationId}
            AND resource_type = types.resource_type
            AND resource_id IS NOT NULL
          ORDER BY resource_id
          LIMIT 1
        ) first
        UNION ALL
        SELECT walk.resource_type, next.resource_id
        FROM walk
        CROSS JOIN LATERAL (
          SELECT resource_id FROM ${table}
          WHERE organization_id = ${opts.organizationId}
            AND resource_type = walk.resource_type
            AND resource_id IS NOT NULL
            AND resource_id > walk.resource_id
          ORDER BY resource_id
          LIMIT 1
        ) next
      ),
      resources AS (${resources})
      SELECT resources.resource_type, resources.resource_id, latest.resource_name
      FROM resources
      CROSS JOIN LATERAL (
        SELECT resource_name FROM ${table}
        WHERE organization_id = ${opts.organizationId}
          AND resource_type = resources.resource_type
          AND resource_id = resources.resource_id
          AND resource_name IS NOT NULL
          ${opts.actorId ? sql`AND actor_id = ${opts.actorId}` : sql``}
        -- NULLS LAST matches the index, so the probe needs no sort.
        ORDER BY created_at DESC NULLS LAST, event_sequence DESC NULLS LAST
        LIMIT 1
      ) latest
      ${
        opts.search
          ? sql`WHERE latest.resource_name ILIKE ${`%${escapeLikePattern(opts.search)}%`}`
          : sql``
      }
      ORDER BY latest.resource_name, resources.resource_type, resources.resource_id
      LIMIT ${opts.limit}
    `);
    const options = result.rows.map((row) => ({
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      name: row.resource_name,
    }));
    const details = await AuditLogModel.findResourceDetails({
      organizationId: opts.organizationId,
      resources: options,
    });
    return options.map((option) => ({
      ...option,
      detail:
        details.get(`${option.resourceType}:${option.resourceId}`) ?? null,
    }));
  }

  static async deleteOlderThan(opts: {
    organizationId: string;
    before: Date;
  }): Promise<number> {
    // `.returning({ id })` rather than `result.rowCount` so this works on
    // both the pg driver (production) and the PGlite driver used in tests,
    // which doesn't populate `rowCount` for bare DELETEs.
    const deleted = await db
      .delete(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.organizationId, opts.organizationId),
          lt(schema.auditLogsTable.createdAt, opts.before),
        ),
      )
      .returning({ id: schema.auditLogsTable.id });
    return deleted.length;
  }

  /**
   * Delete every audit row created strictly before `before`, across all
   * organizations. Used by the retention sweep so it can run as a single
   * query instead of N round-trips per org.
   */
  static async deleteAllOlderThan(before: Date): Promise<number> {
    const deleted = await db
      .delete(schema.auditLogsTable)
      .where(lt(schema.auditLogsTable.createdAt, before))
      .returning({ id: schema.auditLogsTable.id });
    return deleted.length;
  }

  /**
   * The filter predicates both listing methods share, so the offset and
   * cursor paths cannot drift into disagreeing about what a filter means.
   */
  private static buildFilterConditions(opts: {
    organizationId: string;
    startDate?: Date;
    endDate?: Date;
    actorId?: string;
    action?: AuditEventName;
    outcome?: AuditOutcome;
    actorType?: AuditActorType;
    resourceType?: string;
    resourceId?: string;
    search?: string;
  }): SQL[] {
    const conditions: SQL[] = [
      eq(schema.auditLogsTable.organizationId, opts.organizationId),
    ];

    if (opts.startDate) {
      conditions.push(gte(schema.auditLogsTable.createdAt, opts.startDate));
    }
    if (opts.endDate) {
      conditions.push(lte(schema.auditLogsTable.createdAt, opts.endDate));
    }
    if (opts.actorId) {
      if (isServiceAccountUserId(opts.actorId)) {
        conditions.push(
          eq(schema.auditLogsTable.actorType, "service_account"),
          eq(
            schema.auditLogsTable.actorEmail,
            `${opts.actorId.slice(SERVICE_ACCOUNT_USER_ID_PREFIX.length)}@service-account.local`,
          ),
        );
      } else {
        conditions.push(eq(schema.auditLogsTable.actorId, opts.actorId));
      }
    }
    if (opts.action) {
      conditions.push(eq(schema.auditLogsTable.action, opts.action));
    }
    if (opts.outcome) {
      conditions.push(eq(schema.auditLogsTable.outcome, opts.outcome));
    }
    if (opts.actorType) {
      conditions.push(eq(schema.auditLogsTable.actorType, opts.actorType));
    }
    if (opts.resourceType) {
      // A comma-separated list matches any of the types: the event filter
      // offers types that share a page as one entry (a device and its
      // sign-ins).
      const resourceTypes = opts.resourceType
        .split(",")
        .map((type) => type.trim())
        .filter(Boolean);
      conditions.push(
        resourceTypes.length === 1
          ? eq(schema.auditLogsTable.resourceType, resourceTypes[0])
          : inArray(schema.auditLogsTable.resourceType, resourceTypes),
      );
    }
    if (opts.resourceId) {
      conditions.push(eq(schema.auditLogsTable.resourceId, opts.resourceId));
    }
    if (opts.search) {
      const searchCondition = buildSearchCondition(opts.search);
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    return conditions;
  }

  /**
   * Two-column sort: created_at tiebroken by event_sequence (a
   * postgres-assigned bigserial, always monotonic). The matching index covers
   * both columns, and the cursor's keyset predicate compares the same pair.
   */
  private static buildOrderBy(sortDirection: SortDirection) {
    return sortDirection === "asc"
      ? [
          asc(schema.auditLogsTable.createdAt),
          asc(schema.auditLogsTable.eventSequence),
        ]
      : [
          desc(schema.auditLogsTable.createdAt),
          desc(schema.auditLogsTable.eventSequence),
        ];
  }
  /**
   * A second line for each listed resource, read from the resource itself:
   * its owner, then its description. A resource whose row is gone gets none;
   * a soft-deleted one keeps its line, which still tells it apart. The owner
   * comes first because per-member objects share a name ("My Assistant" is
   * seeded once per member).
   */
  private static async findResourceDetails(opts: {
    organizationId: string;
    resources: { resourceType: string; resourceId: string }[];
  }): Promise<Map<string, string>> {
    const idsOf = (type: string, uuidOnly = true) =>
      opts.resources
        .filter(
          (r) =>
            r.resourceType === type &&
            (!uuidOnly || UUID_RE.test(r.resourceId)),
        )
        .map((r) => r.resourceId);
    const owner = schema.usersTable;
    const org = opts.organizationId;
    const describe = (row: {
      ownerName?: string | null;
      description: string | null;
    }) =>
      [row.ownerName?.trim(), row.description?.trim()]
        .filter(Boolean)
        .join(" · ") || null;

    const [agents, skills, mcpServers, apps, environments, roles, teams] =
      await Promise.all([
        AuditLogModel.detailRows(idsOf("agent"), (ids) =>
          db
            .select({
              id: schema.agentsTable.id,
              ownerName: owner.name,
              description: schema.agentsTable.description,
            })
            .from(schema.agentsTable)
            .leftJoin(owner, eq(owner.id, schema.agentsTable.authorId))
            .where(
              and(
                eq(schema.agentsTable.organizationId, org),
                inArray(schema.agentsTable.id, ids),
              ),
            ),
        ),
        AuditLogModel.detailRows(idsOf("skill"), (ids) =>
          db
            .select({
              id: schema.skillsTable.id,
              ownerName: owner.name,
              description: schema.skillsTable.description,
            })
            .from(schema.skillsTable)
            .leftJoin(owner, eq(owner.id, schema.skillsTable.authorId))
            .where(
              and(
                eq(schema.skillsTable.organizationId, org),
                inArray(schema.skillsTable.id, ids),
              ),
            ),
        ),
        AuditLogModel.detailRows(idsOf("mcpServer"), (ids) =>
          db
            .select({
              id: schema.mcpServersTable.id,
              ownerName: owner.name,
              description: schema.internalMcpCatalogTable.description,
            })
            .from(schema.mcpServersTable)
            .innerJoin(
              schema.internalMcpCatalogTable,
              eq(
                schema.internalMcpCatalogTable.id,
                schema.mcpServersTable.catalogId,
              ),
            )
            .leftJoin(owner, eq(owner.id, schema.mcpServersTable.ownerId))
            .where(
              and(
                // A catalog entry without an organization serves every one.
                or(
                  isNull(schema.internalMcpCatalogTable.organizationId),
                  eq(schema.internalMcpCatalogTable.organizationId, org),
                ),
                inArray(schema.mcpServersTable.id, ids),
              ),
            ),
        ),
        AuditLogModel.detailRows(idsOf("app"), (ids) =>
          db
            .select({
              id: schema.appsTable.id,
              ownerName: owner.name,
              description: schema.appsTable.description,
            })
            .from(schema.appsTable)
            .leftJoin(owner, eq(owner.id, schema.appsTable.authorId))
            .where(
              and(
                eq(schema.appsTable.organizationId, org),
                inArray(schema.appsTable.id, ids),
              ),
            ),
        ),
        AuditLogModel.detailRows(idsOf("environment"), (ids) =>
          db
            .select({
              id: schema.environmentsTable.id,
              description: schema.environmentsTable.description,
            })
            .from(schema.environmentsTable)
            .where(
              and(
                eq(schema.environmentsTable.organizationId, org),
                inArray(schema.environmentsTable.id, ids),
              ),
            ),
        ),
        AuditLogModel.detailRows(idsOf("role", false), (ids) =>
          db
            .select({
              id: schema.organizationRolesTable.id,
              description: schema.organizationRolesTable.description,
            })
            .from(schema.organizationRolesTable)
            .where(
              and(
                eq(schema.organizationRolesTable.organizationId, org),
                inArray(schema.organizationRolesTable.id, ids),
              ),
            ),
        ),
        AuditLogModel.detailRows(idsOf("team", false), (ids) =>
          db
            .select({
              id: schema.teamsTable.id,
              description: schema.teamsTable.description,
            })
            .from(schema.teamsTable)
            .where(
              and(
                eq(schema.teamsTable.organizationId, org),
                inArray(schema.teamsTable.id, ids),
              ),
            ),
        ),
      ]);

    const details = new Map<string, string>();
    const add = (
      type: string,
      rows: {
        id: string;
        ownerName?: string | null;
        description: string | null;
      }[],
    ) => {
      for (const row of rows) {
        const detail = describe(row);
        if (detail) details.set(`${type}:${row.id}`, detail);
      }
    };
    add("agent", agents);
    add("skill", skills);
    add("mcpServer", mcpServers);
    add("app", apps);
    add("environment", environments);
    add("role", roles);
    add("team", teams);
    return details;
  }

  /** Runs a per-type detail query only when there are ids to look up. */
  private static async detailRows<T>(
    ids: string[],
    query: (ids: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    return ids.length > 0 ? query(ids) : [];
  }
}

export default AuditLogModel;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
