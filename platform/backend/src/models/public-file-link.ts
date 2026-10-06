import type { PaginationQuery } from "@archestra/shared";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  isNull,
  type SQL,
} from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type { PublicFileLink } from "@/types/public-file-link";

/** Link metadata without the frozen bytes or where they are stored. */
type PublicFileLinkMetadata = Omit<
  PublicFileLink,
  "data" | "storageProvider" | "objectKey"
>;

/** A link row joined with the names the admin list shows. */
type PublicFileLinkWithNames = PublicFileLinkMetadata & {
  createdBy: { id: string; name: string; email: string } | null;
  agent: { id: string; name: string } | null;
};

class PublicFileLinkModel {
  static async create(params: {
    organizationId: string;
    token: string;
    fileId: string;
    createdByUserId: string;
    agentId: string | null;
    conversationId: string | null;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    /** Where the frozen copy taken now lives: inline `data` or `objectKey`. */
    storageProvider: PublicFileLink["storageProvider"];
    data: Buffer | null;
    objectKey: string | null;
  }): Promise<PublicFileLinkMetadata> {
    const [row] = await db
      .insert(schema.publicFileLinksTable)
      .values(params)
      .returning(metadataColumns());
    return row;
  }

  /** The live (not revoked) link for a token, with its frozen bytes, or null. */
  static async findActiveByToken(
    token: string,
  ): Promise<PublicFileLink | null> {
    const [row] = await db
      .select()
      .from(schema.publicFileLinksTable)
      .where(
        and(
          eq(schema.publicFileLinksTable.token, token),
          isNull(schema.publicFileLinksTable.revokedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Links in the organization, newest first, with creator and agent names —
   * all of them, or only the ones `createdByUserId` asked for.
   */
  static async list(params: {
    organizationId: string;
    createdByUserId?: string;
    pagination: PaginationQuery;
  }): Promise<PaginatedResult<PublicFileLinkWithNames>> {
    const table = schema.publicFileLinksTable;
    const where = and(
      eq(table.organizationId, params.organizationId),
      params.createdByUserId
        ? eq(table.createdByUserId, params.createdByUserId)
        : undefined,
    ) as SQL;
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          link: metadataColumns(),
          userId: schema.usersTable.id,
          userName: schema.usersTable.name,
          userEmail: schema.usersTable.email,
          agentId: schema.agentsTable.id,
          agentName: schema.agentsTable.name,
        })
        .from(table)
        .leftJoin(
          schema.usersTable,
          eq(schema.usersTable.id, table.createdByUserId),
        )
        .leftJoin(schema.agentsTable, eq(schema.agentsTable.id, table.agentId))
        .where(where)
        .orderBy(desc(table.createdAt), desc(table.id))
        .limit(params.pagination.limit)
        .offset(params.pagination.offset),
      db.select({ total: count() }).from(table).where(where),
    ]);

    return createPaginatedResult(
      rows.map((row) => ({
        ...row.link,
        createdBy:
          row.userId && row.userName !== null && row.userEmail !== null
            ? { id: row.userId, name: row.userName, email: row.userEmail }
            : null,
        agent:
          row.agentId && row.agentName !== null
            ? { id: row.agentId, name: row.agentName }
            : null,
      })),
      Number(total),
      params.pagination,
    );
  }

  /**
   * Revoke a link in the organization (and, with `createdByUserId`, only if
   * that user created it), dropping its inline bytes and external key — a
   * revoked link never serves again. Idempotent: an already-revoked link keeps
   * its original `revokedAt`. Returns null when no such link exists; otherwise
   * the external object the caller must now remove, if this call revoked one.
   */
  static async revoke(params: {
    id: string;
    organizationId: string;
    createdByUserId?: string;
  }): Promise<{
    removedObject: { provider: string; objectKey: string } | null;
  } | null> {
    const table = schema.publicFileLinksTable;
    const existing = await PublicFileLinkModel.findById(params);
    if (!existing) return null;
    if (
      params.createdByUserId &&
      existing.createdByUserId !== params.createdByUserId
    ) {
      return null;
    }
    if (existing.revokedAt) return { removedObject: null };
    // read the old location in the same statement that clears it, so two
    // concurrent revokes never both claim the object.
    const [revoked] = await db
      .update(table)
      .set({ revokedAt: new Date(), data: null, objectKey: null })
      .where(and(eq(table.id, params.id), isNull(table.revokedAt)))
      .returning({ id: table.id });
    if (!revoked) return { removedObject: null };
    return {
      removedObject:
        existing.storageProvider !== "db" && existing.objectKey
          ? {
              provider: existing.storageProvider,
              objectKey: existing.objectKey,
            }
          : null,
    };
  }

  /** Audit snapshot. The token is a bearer credential, so it is left out. */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const link = await PublicFileLinkModel.findById({ id, organizationId });
    if (!link) return null;
    const { token: _token, objectKey: _objectKey, ...safe } = link;
    return safe;
  }

  private static async findById(params: {
    id: string;
    organizationId: string;
  }): Promise<Omit<PublicFileLink, "data"> | null> {
    const { data: _data, ...columns } = getTableColumns(
      schema.publicFileLinksTable,
    );
    const [row] = await db
      .select(columns)
      .from(schema.publicFileLinksTable)
      .where(
        and(
          eq(schema.publicFileLinksTable.id, params.id),
          eq(schema.publicFileLinksTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  }
}

export default PublicFileLinkModel;

// === internal helpers ===

/** Every column but the bytes and their location, for listings and snapshots. */
function metadataColumns() {
  const {
    data: _data,
    storageProvider: _storageProvider,
    objectKey: _objectKey,
    ...columns
  } = getTableColumns(schema.publicFileLinksTable);
  return columns;
}
