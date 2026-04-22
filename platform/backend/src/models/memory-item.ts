import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
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
import type {
  InsertMemoryItem,
  MemoryItem,
  MemoryKind,
  MemoryRejectionReason,
  MemoryScopeType,
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
    limit: number;
    offset: number;
  }): Promise<MemoryItem[]> {
    const teamIds = params.teamIds ?? [];
    const conditions: SQL[] = [
      eq(schema.memoryItemsTable.organizationId, params.organizationId),
      MemoryItemModel.buildVisibleScopePredicate({
        userId: params.userId,
        organizationId: params.organizationId,
        teamIds,
        includeOrganizationScope: params.isOrgAdmin,
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

    return await db
      .select()
      .from(schema.memoryItemsTable)
      .where(and(...conditions))
      .orderBy(desc(schema.memoryItemsTable.createdAt))
      .limit(params.limit)
      .offset(params.offset);
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
    const [updated] = await db
      .update(schema.memoryItemsTable)
      .set(params.patch)
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

      const [created] = await tx
        .insert(schema.memoryItemsTable)
        .values({
          organizationId: source.organizationId,
          scopeType: source.scopeType,
          scopeId: source.scopeId,
          kind: params.patch.kind ?? source.kind,
          status: "candidate",
          content: params.patch.content ?? source.content,
          createdBy: params.requesterId,
          extractorVersion: source.extractorVersion,
          policyFlags: source.policyFlags,
          sourceConversationId: source.sourceConversationId,
          sourceMessageIds: source.sourceMessageIds,
          supersedesMemoryId: source.id,
          confidenceBand: source.confidenceBand,
          language: source.language,
          expiresAt: params.patch.expiresAt ?? source.expiresAt,
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
          eq(schema.memoryItemsTable.scopeId, params.scopeId),
          eq(schema.memoryItemsTable.status, params.status),
        ),
      );

    return Number(result?.total ?? 0);
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

  private static buildVisibleScopePredicate(params: {
    userId: string;
    organizationId: string;
    teamIds: string[];
    includeOrganizationScope: boolean;
  }): SQL {
    const scopePredicates: SQL[] = [
      and(
        eq(schema.memoryItemsTable.scopeType, "user"),
        eq(schema.memoryItemsTable.scopeId, params.userId),
      ) as SQL,
    ];

    if (params.teamIds.length > 0) {
      scopePredicates.push(
        and(
          eq(schema.memoryItemsTable.scopeType, "team"),
          inArray(schema.memoryItemsTable.scopeId, params.teamIds),
        ) as SQL,
      );
    }

    if (params.includeOrganizationScope) {
      scopePredicates.push(
        and(
          eq(schema.memoryItemsTable.scopeType, "organization"),
          eq(schema.memoryItemsTable.scopeId, params.organizationId),
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
        eq(schema.memoryItemsTable.scopeId, params.requesterUserId),
      ) as SQL,
    ];

    if (
      MemoryItemModel.canReviewTeamScope(normalizedRequesterRole) &&
      params.teamIds.length > 0
    ) {
      scopePredicates.push(
        and(
          eq(schema.memoryItemsTable.scopeType, "team"),
          inArray(schema.memoryItemsTable.scopeId, params.teamIds),
        ) as SQL,
      );
    }

    if (MemoryItemModel.canReviewOrganizationScope(normalizedRequesterRole)) {
      scopePredicates.push(
        and(
          eq(schema.memoryItemsTable.scopeType, "organization"),
          eq(schema.memoryItemsTable.scopeId, params.organizationId),
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

  private static isTransitionAllowed(
    currentStatus: MemoryStatus,
    nextStatus: MemoryStatus,
  ): boolean {
    if (currentStatus === "candidate") {
      return nextStatus === "approved" || nextStatus === "rejected";
    }
    if (currentStatus === "approved") {
      return nextStatus === "archived";
    }
    if (currentStatus === "archived") {
      return nextStatus === "approved";
    }

    return false;
  }
}

export default MemoryItemModel;

const MS_IN_DAY = 24 * 60 * 60 * 1000;
