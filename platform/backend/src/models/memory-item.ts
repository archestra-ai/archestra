import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  isNull,
  lt,
  ne,
  not,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import {
  type MemoryRequesterRole,
  normalizeMemoryRequesterRole,
} from "@/memory/policy/requester-role";
import {
  buildFallbackSourceContract,
  validateSourceContract,
} from "@/memory/provenance/source-contract";
import type {
  InsertMemoryItem,
  MemoryItem,
  MemoryKind,
  MemoryPolicyFlag,
  MemoryRejectionReason,
  MemoryScopeType,
  MemorySourceType,
  MemoryStatus,
  UpdateMemoryItem,
} from "@/types/memory-item";
import MemoryTombstoneModel from "./memory-tombstone";

type SupersedingPatch = Partial<
  Pick<UpdateMemoryItem, "content" | "kind" | "expiresAt">
>;

class MemoryItemModel {
  static async create(data: InsertMemoryItem): Promise<MemoryItem> {
    const [item] = await db
      .insert(schema.memoryItemsTable)
      .values(data)
      .returning();

    return item;
  }

  static async getById(params: {
    id: string;
    organizationId: string;
  }): Promise<MemoryItem | null> {
    const [item] = await db
      .select()
      .from(schema.memoryItemsTable)
      .where(
        and(
          eq(schema.memoryItemsTable.id, params.id),
          eq(schema.memoryItemsTable.organizationId, params.organizationId),
        ),
      )
      .limit(1);

    return item ?? null;
  }

  static async listForUser(params: {
    userId: string;
    organizationId: string;
    teamIds?: string[];
    isOrgAdmin: boolean;
    scopeType?: MemoryScopeType;
    status?: MemoryStatus;
    kind?: MemoryKind;
    sourceType?: MemorySourceType;
    sourceId?: string;
    search?: string;
    limit: number;
    offset: number;
  }): Promise<MemoryItem[]> {
    const conditions = MemoryItemModel.buildListForUserConditions(params);

    return await db
      .select()
      .from(schema.memoryItemsTable)
      .where(and(...conditions))
      .orderBy(desc(schema.memoryItemsTable.createdAt))
      .limit(params.limit)
      .offset(params.offset);
  }

  static async countForUser(params: {
    userId: string;
    organizationId: string;
    teamIds?: string[];
    isOrgAdmin: boolean;
    scopeType?: MemoryScopeType;
    status?: MemoryStatus;
    kind?: MemoryKind;
    sourceType?: MemorySourceType;
    sourceId?: string;
    search?: string;
  }): Promise<number> {
    const conditions = MemoryItemModel.buildListForUserConditions(params);

    const [result] = await db
      .select({ total: count() })
      .from(schema.memoryItemsTable)
      .where(and(...conditions));

    return Number(result?.total ?? 0);
  }

  static async countPendingReview(params: {
    organizationId: string;
    requesterUserId: string;
    requesterRole: string;
    teamIds?: string[];
  }): Promise<number> {
    const teamIds = params.teamIds ?? [];

    const [result] = await db
      .select({ total: count() })
      .from(schema.memoryItemsTable)
      .where(
        and(
          eq(schema.memoryItemsTable.organizationId, params.organizationId),
          eq(schema.memoryItemsTable.status, "candidate"),
          MemoryItemModel.buildPendingReviewScopePredicate({
            organizationId: params.organizationId,
            requesterUserId: params.requesterUserId,
            requesterRole: params.requesterRole,
            teamIds,
          }),
        ),
      );

    return Number(result?.total ?? 0);
  }

  static async listPendingReview(params: {
    organizationId: string;
    requesterUserId: string;
    requesterRole: string;
    teamIds?: string[];
    limit: number;
    offset: number;
  }): Promise<MemoryItem[]> {
    const teamIds = params.teamIds ?? [];

    return await db
      .select()
      .from(schema.memoryItemsTable)
      .where(
        and(
          eq(schema.memoryItemsTable.organizationId, params.organizationId),
          eq(schema.memoryItemsTable.status, "candidate"),
          MemoryItemModel.buildPendingReviewScopePredicate({
            organizationId: params.organizationId,
            requesterUserId: params.requesterUserId,
            requesterRole: params.requesterRole,
            teamIds,
          }),
        ),
      )
      .orderBy(asc(schema.memoryItemsTable.createdAt))
      .limit(params.limit)
      .offset(params.offset);
  }

  static async updateCandidate(params: {
    id: string;
    organizationId: string;
    patch: UpdateMemoryItem;
  }): Promise<MemoryItem | null> {
    const rawPatch = params.patch as UpdateMemoryItem & {
      sourceType?: MemorySourceType;
      sourceId?: string;
      sourceMetadata?: unknown;
    };
    const {
      sourceType: _sourceType,
      sourceId: _sourceId,
      sourceMetadata: _sourceMetadata,
      ...safePatch
    } = rawPatch;

    const [updated] = await db
      .update(schema.memoryItemsTable)
      .set(safePatch)
      .where(
        and(
          eq(schema.memoryItemsTable.id, params.id),
          eq(schema.memoryItemsTable.organizationId, params.organizationId),
          ne(schema.memoryItemsTable.status, "approved"),
        ),
      )
      .returning();

    return updated ?? null;
  }

  static async createSupersedingCandidate(params: {
    id: string;
    organizationId: string;
    patch: SupersedingPatch;
    requesterId: string;
    policyFlags?: MemoryPolicyFlag[];
    status?: MemoryStatus;
    scores?: import("@/types/memory-item").MemoryItemScores | null;
    classifications?:
      | import("@/types/memory-item").MemoryItemClassifications
      | null;
    scorerVersion?: string | null;
  }): Promise<MemoryItem> {
    return await db.transaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(schema.memoryItemsTable)
        .where(
          and(
            eq(schema.memoryItemsTable.id, params.id),
            eq(schema.memoryItemsTable.organizationId, params.organizationId),
          ),
        )
        .limit(1);

      if (!source) {
        throw new Error("Memory item not found");
      }
      if (source.status !== "approved") {
        throw new Error("Only approved memory can be superseded");
      }

      const sourceContract =
        source.sourceType && source.sourceId && source.sourceMetadata
          ? validateSourceContract({
              sourceType: source.sourceType,
              sourceId: source.sourceId,
              sourceMetadata: source.sourceMetadata,
            })
          : buildFallbackSourceContract({
              sourceConversationId: source.sourceConversationId,
              sourceMessageIds: source.sourceMessageIds,
              createdBy: source.createdBy,
              scopeType: source.scopeType,
              scopeId: source.scopeId,
              policyFlags: source.policyFlags,
              extractorVersion: source.extractorVersion,
              future: null,
            });

      const [created] = await tx
        .insert(schema.memoryItemsTable)
        .values({
          organizationId: source.organizationId,
          scopeType: source.scopeType,
          scopeId: source.scopeId,
          kind: params.patch.kind ?? source.kind,
          status: params.status ?? "candidate",
          content: params.patch.content ?? source.content,
          createdBy: params.requesterId,
          extractorVersion: source.extractorVersion,
          policyFlags: params.policyFlags ?? source.policyFlags,
          sourceConversationId: source.sourceConversationId,
          sourceMessageIds: source.sourceMessageIds,
          sourceType: sourceContract.sourceType,
          sourceId: sourceContract.sourceId,
          sourceMetadata: sourceContract.sourceMetadata,
          supersedesMemoryId: source.id,
          confidenceBand: source.confidenceBand,
          language: source.language,
          expiresAt: params.patch.expiresAt ?? source.expiresAt,
          scores: params.scores,
          classifications: params.classifications,
          scorerVersion: params.scorerVersion,
        })
        .returning();

      return created;
    });
  }

  static async transitionStatus(params: {
    id: string;
    organizationId: string;
    newStatus: MemoryStatus;
    reviewerId: string;
    rejectionReason?: MemoryRejectionReason;
    rejectionComment?: string;
  }): Promise<MemoryItem | null> {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.memoryItemsTable)
        .where(
          and(
            eq(schema.memoryItemsTable.id, params.id),
            eq(schema.memoryItemsTable.organizationId, params.organizationId),
          ),
        )
        .limit(1);

      if (!current) {
        return null;
      }

      if (
        !MemoryItemModel.isTransitionAllowed(current.status, params.newStatus)
      ) {
        return null;
      }

      if (params.newStatus === "rejected" && !params.rejectionReason) {
        return null;
      }

      const now = new Date();
      const nextRejectionReason =
        params.newStatus === "rejected"
          ? (params.rejectionReason ?? null)
          : null;

      const [updated] = await tx
        .update(schema.memoryItemsTable)
        .set({
          status: params.newStatus,
          reviewedBy: params.reviewerId,
          reviewedAt: now,
          rejectionReason: nextRejectionReason,
          rejectionComment:
            params.newStatus === "rejected"
              ? (params.rejectionComment ?? null)
              : null,
          lastVerifiedAt: params.newStatus === "approved" ? now : null,
        })
        .where(
          and(
            eq(schema.memoryItemsTable.id, params.id),
            eq(schema.memoryItemsTable.organizationId, params.organizationId),
            eq(schema.memoryItemsTable.status, current.status),
          ),
        )
        .returning();

      return updated ?? null;
    });
  }

  static async hardDelete(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    return await db.transaction(async (tx) => {
      const [item] = await tx
        .select()
        .from(schema.memoryItemsTable)
        .where(
          and(
            eq(schema.memoryItemsTable.id, params.id),
            eq(schema.memoryItemsTable.organizationId, params.organizationId),
          ),
        )
        .limit(1);

      if (!item) {
        return false;
      }

      await MemoryTombstoneModel.record(
        {
          organizationId: item.organizationId,
          scopeType: item.scopeType,
          scopeId: item.scopeId,
          content: item.content,
          reason: "deleted_by_user",
        },
        tx,
      );

      const deleted = await tx
        .delete(schema.memoryItemsTable)
        .where(
          and(
            eq(schema.memoryItemsTable.id, params.id),
            eq(schema.memoryItemsTable.organizationId, params.organizationId),
          ),
        )
        .returning({ id: schema.memoryItemsTable.id });

      return deleted.length > 0;
    });
  }

  static async archiveStaleCandidates(params: {
    organizationId: string;
    ttlDays: number;
  }): Promise<number> {
    const cutoff = new Date(Date.now() - params.ttlDays * MS_IN_DAY);

    const archived = await db
      .update(schema.memoryItemsTable)
      .set({
        status: "archived",
      })
      .where(
        and(
          eq(schema.memoryItemsTable.organizationId, params.organizationId),
          eq(schema.memoryItemsTable.status, "candidate"),
          lt(schema.memoryItemsTable.createdAt, cutoff),
        ),
      )
      .returning({ id: schema.memoryItemsTable.id });

    return archived.length;
  }

  static async markSourceDeletedByConversation(params: {
    organizationId: string;
    conversationId: string;
  }): Promise<number> {
    const updated = await db
      .update(schema.memoryItemsTable)
      .set({
        sourceConversationId: null,
        policyFlags: sql`CASE
          WHEN 'source_deleted' = ANY(${schema.memoryItemsTable.policyFlags})
            THEN ${schema.memoryItemsTable.policyFlags}
          ELSE ${schema.memoryItemsTable.policyFlags} || ARRAY['source_deleted']::text[]
        END`,
      })
      .where(
        and(
          eq(schema.memoryItemsTable.organizationId, params.organizationId),
          eq(
            schema.memoryItemsTable.sourceConversationId,
            params.conversationId,
          ),
          isNull(schema.memoryItemsTable.createdBy),
        ),
      )
      .returning({ id: schema.memoryItemsTable.id });

    return updated.length;
  }

  static async countByScopeAndStatus(params: {
    organizationId: string;
    scopeType: MemoryScopeType;
    scopeId: string;
    status: MemoryStatus;
  }): Promise<number> {
    const [result] = await db
      .select({ total: count() })
      .from(schema.memoryItemsTable)
      .where(
        and(
          eq(schema.memoryItemsTable.organizationId, params.organizationId),
          eq(schema.memoryItemsTable.scopeType, params.scopeType),
          MemoryItemModel.scopeIdEquals(params.scopeId),
          eq(schema.memoryItemsTable.status, params.status),
        ),
      );

    return Number(result?.total ?? 0);
  }

  static async listApprovedContentHashesForScope(params: {
    organizationId: string;
    scopeType: MemoryScopeType;
    scopeId: string;
  }): Promise<string[]> {
    const rows = await db
      .select({
        content: schema.memoryItemsTable.content,
      })
      .from(schema.memoryItemsTable)
      .where(
        and(
          eq(schema.memoryItemsTable.organizationId, params.organizationId),
          eq(schema.memoryItemsTable.scopeType, params.scopeType),
          MemoryItemModel.scopeIdEquals(params.scopeId),
          eq(schema.memoryItemsTable.status, "approved"),
        ),
      );

    return rows.map((row) => MemoryTombstoneModel.getContentHash(row.content));
  }

  static async listApprovedForRetrieval(params: {
    userId: string;
    organizationId: string;
    teamIds?: string[];
    limit: number;
    includeOrganizationScope?: boolean;
  }): Promise<MemoryItem[]> {
    const teamIds = params.teamIds ?? [];
    const orphanedRecordPredicate = or(
      and(
        isNull(schema.memoryItemsTable.createdBy),
        isNull(schema.memoryItemsTable.sourceConversationId),
      ),
      sql`'source_deleted' = ANY(${schema.memoryItemsTable.policyFlags})`,
    );

    return await db
      .select()
      .from(schema.memoryItemsTable)
      .where(
        and(
          eq(schema.memoryItemsTable.organizationId, params.organizationId),
          eq(schema.memoryItemsTable.status, "approved"),
          MemoryItemModel.buildVisibleScopePredicate({
            userId: params.userId,
            organizationId: params.organizationId,
            teamIds,
            includeOrganizationScope: params.includeOrganizationScope ?? false,
            isOrgAdmin: false,
          }),
          orphanedRecordPredicate ? not(orphanedRecordPredicate) : sql`true`,
        ),
      )
      .orderBy(
        desc(schema.memoryItemsTable.lastVerifiedAt),
        desc(schema.memoryItemsTable.updatedAt),
        desc(schema.memoryItemsTable.createdAt),
      )
      .limit(params.limit);
  }

  static async existsByIngestionIdempotencyKey(params: {
    organizationId: string;
    sourceType: MemorySourceType;
    idempotencyKey: string;
  }): Promise<boolean> {
    if (!params.idempotencyKey.trim()) {
      return false;
    }

    const [result] = await db
      .select({ total: count() })
      .from(schema.memoryItemsTable)
      .where(
        and(
          eq(schema.memoryItemsTable.organizationId, params.organizationId),
          eq(schema.memoryItemsTable.sourceType, params.sourceType),
          sql`${schema.memoryItemsTable.sourceMetadata} -> 'ingestion' ->> 'idempotencyKey' = ${params.idempotencyKey}`,
        ),
      );

    return Number(result?.total ?? 0) > 0;
  }

  private static buildListForUserConditions(params: {
    userId: string;
    organizationId: string;
    teamIds?: string[];
    isOrgAdmin: boolean;
    scopeType?: MemoryScopeType;
    status?: MemoryStatus;
    kind?: MemoryKind;
    sourceType?: MemorySourceType;
    sourceId?: string;
    search?: string;
  }): SQL[] {
    const teamIds = params.teamIds ?? [];
    const conditions: SQL[] = [
      eq(schema.memoryItemsTable.organizationId, params.organizationId),
      MemoryItemModel.buildVisibleScopePredicate({
        userId: params.userId,
        organizationId: params.organizationId,
        teamIds,
        includeOrganizationScope: params.isOrgAdmin,
        isOrgAdmin: params.isOrgAdmin,
      }),
    ];

    if (params.scopeType) {
      conditions.push(eq(schema.memoryItemsTable.scopeType, params.scopeType));
    }
    if (params.status) {
      conditions.push(eq(schema.memoryItemsTable.status, params.status));
    }
    if (params.kind) {
      conditions.push(eq(schema.memoryItemsTable.kind, params.kind));
    }
    if (params.sourceType) {
      conditions.push(
        eq(schema.memoryItemsTable.sourceType, params.sourceType),
      );
    }
    if (params.sourceId) {
      conditions.push(eq(schema.memoryItemsTable.sourceId, params.sourceId));
    }
    if (params.search) {
      conditions.push(
        ilike(schema.memoryItemsTable.content, `%${params.search}%`),
      );
    }

    return conditions;
  }

  private static buildVisibleScopePredicate(params: {
    userId: string;
    organizationId: string;
    teamIds: string[];
    includeOrganizationScope: boolean;
    isOrgAdmin: boolean;
  }): SQL {
    const scopePredicates: SQL[] = [
      and(
        eq(schema.memoryItemsTable.scopeType, "user"),
        MemoryItemModel.scopeIdEquals(params.userId),
      ) as SQL,
    ];

    if (params.isOrgAdmin) {
      // org-admin sees all team-scope items in the organization without requiring team membership
      scopePredicates.push(
        eq(schema.memoryItemsTable.scopeType, "team") as SQL,
      );
    } else if (params.teamIds.length > 0) {
      scopePredicates.push(
        and(
          eq(schema.memoryItemsTable.scopeType, "team"),
          MemoryItemModel.scopeIdIn(params.teamIds),
        ) as SQL,
      );
    }

    if (params.includeOrganizationScope) {
      scopePredicates.push(
        and(
          eq(schema.memoryItemsTable.scopeType, "organization"),
          MemoryItemModel.scopeIdEquals(params.organizationId),
        ) as SQL,
      );
    }

    const scopePredicate = or(...scopePredicates);
    return scopePredicate ?? sql`false`;
  }

  private static buildPendingReviewScopePredicate(params: {
    organizationId: string;
    requesterUserId: string;
    requesterRole: string;
    teamIds: string[];
  }): SQL {
    // Keep requesterRole handling deterministic for review-queue filtering.
    const normalizedRequesterRole = normalizeMemoryRequesterRole(
      params.requesterRole,
    );
    const scopePredicates: SQL[] = [
      and(
        eq(schema.memoryItemsTable.scopeType, "user"),
        MemoryItemModel.scopeIdEquals(params.requesterUserId),
      ) as SQL,
    ];

    if (normalizedRequesterRole === "admin") {
      // admin sees all pending team-scope items in the organization without requiring team membership
      scopePredicates.push(
        eq(schema.memoryItemsTable.scopeType, "team") as SQL,
      );
    } else if (
      MemoryItemModel.canReviewTeamScope(normalizedRequesterRole) &&
      params.teamIds.length > 0
    ) {
      scopePredicates.push(
        and(
          eq(schema.memoryItemsTable.scopeType, "team"),
          MemoryItemModel.scopeIdIn(params.teamIds),
        ) as SQL,
      );
    }

    if (MemoryItemModel.canReviewOrganizationScope(normalizedRequesterRole)) {
      scopePredicates.push(
        and(
          eq(schema.memoryItemsTable.scopeType, "organization"),
          MemoryItemModel.scopeIdEquals(params.organizationId),
        ) as SQL,
      );
    }

    const scopePredicate = or(...scopePredicates);
    return scopePredicate ?? sql`false`;
  }

  private static canReviewTeamScope(role: MemoryRequesterRole): boolean {
    return role === "admin" || role === "team-admin";
  }

  private static canReviewOrganizationScope(
    role: MemoryRequesterRole,
  ): boolean {
    return role === "admin";
  }

  private static scopeIdEquals(scopeId: string): SQL {
    // Legacy compatibility: some environments may still have memory_item.scope_id typed as uuid.
    // Casting the DB column to text prevents invalid uuid cast failures for text IDs.
    return sql`${schema.memoryItemsTable.scopeId}::text = ${scopeId}`;
  }

  private static scopeIdIn(scopeIds: string[]): SQL {
    if (scopeIds.length === 0) {
      return sql`false`;
    }

    const scopePredicates = scopeIds.map((scopeId) =>
      MemoryItemModel.scopeIdEquals(scopeId),
    );
    const scopePredicate = or(...scopePredicates);
    return scopePredicate ?? sql`false`;
  }

  static async incrementRetrievalCount(id: string): Promise<void> {
    await db
      .update(schema.memoryItemsTable)
      .set({
        retrievalCount: sql`${schema.memoryItemsTable.retrievalCount} + 1`,
        lastRetrievedAt: new Date(),
      })
      .where(eq(schema.memoryItemsTable.id, id));
  }

  private static isTransitionAllowed(
    currentStatus: MemoryStatus,
    nextStatus: MemoryStatus,
  ): boolean {
    if (currentStatus === "candidate") {
      return (
        nextStatus === "approved" ||
        nextStatus === "rejected" ||
        nextStatus === "archived" ||
        nextStatus === "quarantined"
      );
    }
    if (currentStatus === "approved") {
      return nextStatus === "archived";
    }
    if (currentStatus === "rejected") {
      return nextStatus === "archived";
    }
    if (currentStatus === "archived") {
      return nextStatus === "candidate";
    }
    if (currentStatus === "quarantined") {
      return nextStatus === "rejected" || nextStatus === "archived";
    }

    return false;
  }
}

export default MemoryItemModel;

const MS_IN_DAY = 24 * 60 * 60 * 1000;
