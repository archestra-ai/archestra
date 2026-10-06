import type { PaginationQuery } from "@archestra/shared";
import { and, count, desc, eq, getTableColumns, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type { PublicFileLink } from "@/types/public-file-link";

/** Link metadata without the frozen bytes (everything but the serve path). */
type PublicFileLinkMetadata = Omit<PublicFileLink, "data">;

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
    /** The frozen copy the link serves, taken now. */
    data: Buffer;
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

  /** Every link in the organization, newest first, with creator and agent names. */
  static async listForOrganization(params: {
    organizationId: string;
    pagination: PaginationQuery;
  }): Promise<PaginatedResult<PublicFileLinkWithNames>> {
    const table = schema.publicFileLinksTable;
    const where = eq(table.organizationId, params.organizationId);
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
   * Revoke a link in the organization and drop its frozen bytes — a revoked
   * link never serves again, so they would only take up storage. Idempotent:
   * an already-revoked link keeps its original `revokedAt`. Returns false when
   * no such link exists in the organization.
   */
  static async revoke(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const table = schema.publicFileLinksTable;
    const existing = await PublicFileLinkModel.findById(params);
    if (!existing) return false;
    if (existing.revokedAt) return true;
    await db
      .update(table)
      .set({ revokedAt: new Date(), data: null })
      .where(and(eq(table.id, params.id), isNull(table.revokedAt)));
    return true;
  }

  /** Audit snapshot. The token is a bearer credential, so it is left out. */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const link = await PublicFileLinkModel.findById({ id, organizationId });
    if (!link) return null;
    const { token: _token, ...safe } = link;
    return safe;
  }

  private static async findById(params: {
    id: string;
    organizationId: string;
  }): Promise<PublicFileLinkMetadata | null> {
    const [row] = await db
      .select(metadataColumns())
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

/** Every column but `data`, so listings and snapshots never load the bytes. */
function metadataColumns() {
  const { data: _data, ...columns } = getTableColumns(
    schema.publicFileLinksTable,
  );
  return columns;
}
