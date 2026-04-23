import config from "@/config";
import logger from "@/logging";
import { canApproveMemory } from "@/memory/policy/can-approve";
import { canDeleteMemory } from "@/memory/policy/can-delete";
import { canReadMemory } from "@/memory/policy/can-read";
import {
  type MemoryRequesterRole,
  normalizeMemoryRequesterRole,
} from "@/memory/policy/requester-role";
import { reportMemoryReviewed } from "@/memory/telemetry/metrics";
import {
  setMemorySpanAttributes,
  withMemorySpan,
} from "@/memory/telemetry/spans";
import MemoryItemModel from "@/models/memory-item";
import MemoryTombstoneModel from "@/models/memory-tombstone";
import type {
  InsertMemoryItem,
  MemoryItem,
  MemoryRejectionReason,
  UpdateMemoryItem,
} from "@/types/memory-item";

export type MemoryReviewRequester = {
  id: string;
  role: string | null | undefined;
};

export type ApproveMemoryParams = {
  itemId: string;
  organizationId: string;
  reviewer: MemoryReviewRequester;
  teamIds?: string[];
};

export type RejectMemoryParams = ApproveMemoryParams & {
  rejectionReason: MemoryRejectionReason;
  rejectionComment?: string;
};

export type ManualCreateMemoryData = Pick<
  InsertMemoryItem,
  "scopeType" | "scopeId" | "kind" | "content"
> &
  Partial<
    Pick<
      InsertMemoryItem,
      | "policyFlags"
      | "extractorVersion"
      | "sourceConversationId"
      | "sourceMessageIds"
      | "confidenceBand"
      | "language"
      | "expiresAt"
    >
  >;

export type ManualCreateMemoryParams = {
  organizationId: string;
  data: ManualCreateMemoryData;
  requester: MemoryReviewRequester;
  teamIds?: string[];
};

export type ProposeSupersedingEditParams = {
  itemId: string;
  organizationId: string;
  patch: Partial<Pick<UpdateMemoryItem, "content" | "kind" | "expiresAt">>;
  requester: MemoryReviewRequester;
  teamIds?: string[];
};

export async function approve(
  params: ApproveMemoryParams,
): Promise<MemoryItem | null> {
  return withMemorySpan("approve", async (span) => {
    const accessContext = await getAccessContext({
      itemId: params.itemId,
      organizationId: params.organizationId,
      requester: params.reviewer,
      teamIds: params.teamIds ?? [],
    });
    if (!accessContext) {
      return null;
    }

    setMemorySpanAttributes(span, {
      scopeType: accessContext.item.scopeType,
      scopeId: accessContext.item.scopeId,
    });

    if (
      !canApproveMemory({
        requesterUserId: params.reviewer.id,
        requesterRole: accessContext.requesterRole,
        organizationId: params.organizationId,
        requesterTeamIds: accessContext.teamIds,
        item: accessContext.item,
      })
    ) {
      logger.info(
        {
          itemId: params.itemId,
          requesterId: params.reviewer.id,
        },
        "[memory] approve: blocked by authorization",
      );
      return null;
    }

    const approved = await MemoryItemModel.transitionStatus({
      id: params.itemId,
      organizationId: params.organizationId,
      newStatus: "approved",
      reviewerId: params.reviewer.id,
    });

    if (approved) {
      reportMemoryReviewed({
        scopeType: approved.scopeType,
        outcome: "approved",
      });
    }

    return approved;
  });
}

export async function reject(
  params: RejectMemoryParams,
): Promise<MemoryItem | null> {
  return withMemorySpan("reject", async (span) => {
    const accessContext = await getAccessContext({
      itemId: params.itemId,
      organizationId: params.organizationId,
      requester: params.reviewer,
      teamIds: params.teamIds ?? [],
    });
    if (!accessContext) {
      return null;
    }

    setMemorySpanAttributes(span, {
      scopeType: accessContext.item.scopeType,
      scopeId: accessContext.item.scopeId,
      rejectionReason: params.rejectionReason,
    });

    if (
      !canApproveMemory({
        requesterUserId: params.reviewer.id,
        requesterRole: accessContext.requesterRole,
        organizationId: params.organizationId,
        requesterTeamIds: accessContext.teamIds,
        item: accessContext.item,
      })
    ) {
      logger.info(
        {
          itemId: params.itemId,
          requesterId: params.reviewer.id,
          rejectionReason: params.rejectionReason,
        },
        "[memory] reject: blocked by authorization",
      );
      return null;
    }

    const updatedItem = await MemoryItemModel.transitionStatus({
      id: params.itemId,
      organizationId: params.organizationId,
      newStatus: "rejected",
      reviewerId: params.reviewer.id,
      rejectionReason: params.rejectionReason,
      rejectionComment: params.rejectionComment,
    });
    if (!updatedItem) {
      return null;
    }

    if (shouldCreateRejectionTombstone(params.rejectionReason)) {
      await MemoryTombstoneModel.record({
        organizationId: accessContext.item.organizationId,
        scopeType: accessContext.item.scopeType,
        scopeId: accessContext.item.scopeId,
        content: accessContext.item.content,
        reason: "rejected",
        ttlDays: config.memory.tombstoneTtlDays,
      });
    }

    reportMemoryReviewed({
      scopeType: updatedItem.scopeType,
      outcome: "rejected",
      rejectionReason: params.rejectionReason,
    });

    return updatedItem;
  });
}

export async function manualCreate(
  params: ManualCreateMemoryParams,
): Promise<MemoryItem | null> {
  const requesterRole = normalizeMemoryRequesterRole(params.requester.role);
  const teamIds = params.teamIds ?? [];

  if (
    !canApproveMemory({
      requesterUserId: params.requester.id,
      requesterRole,
      organizationId: params.organizationId,
      requesterTeamIds: teamIds,
      item: {
        scopeType: params.data.scopeType,
        scopeId: params.data.scopeId,
      },
    })
  ) {
    return null;
  }

  return await MemoryItemModel.create({
    organizationId: params.organizationId,
    scopeType: params.data.scopeType,
    scopeId: params.data.scopeId,
    kind: params.data.kind,
    status: "candidate",
    content: params.data.content,
    createdBy: params.requester.id,
    policyFlags: params.data.policyFlags ?? [],
    extractorVersion: params.data.extractorVersion,
    sourceConversationId: params.data.sourceConversationId,
    sourceMessageIds: params.data.sourceMessageIds,
    confidenceBand: params.data.confidenceBand,
    language: params.data.language,
    expiresAt: params.data.expiresAt,
  });
}

export async function proposeSupersedingEdit(
  params: ProposeSupersedingEditParams,
): Promise<MemoryItem | null> {
  if (!params.patch.content && !params.patch.kind && !params.patch.expiresAt) {
    return null;
  }

  const accessContext = await getAccessContext({
    itemId: params.itemId,
    organizationId: params.organizationId,
    requester: params.requester,
    teamIds: params.teamIds ?? [],
  });
  if (!accessContext) {
    return null;
  }

  if (
    !canApproveMemory({
      requesterUserId: params.requester.id,
      requesterRole: accessContext.requesterRole,
      organizationId: params.organizationId,
      requesterTeamIds: accessContext.teamIds,
      item: accessContext.item,
    })
  ) {
    return null;
  }

  try {
    return await MemoryItemModel.createSupersedingCandidate({
      id: params.itemId,
      organizationId: params.organizationId,
      patch: params.patch,
      requesterId: params.requester.id,
    });
  } catch {
    return null;
  }
}

export async function archive(
  params: ApproveMemoryParams,
): Promise<MemoryItem | null> {
  return withMemorySpan("archive", async (span) => {
    const accessContext = await getAccessContext({
      itemId: params.itemId,
      organizationId: params.organizationId,
      requester: params.reviewer,
      teamIds: params.teamIds ?? [],
    });
    if (!accessContext) {
      return null;
    }

    setMemorySpanAttributes(span, {
      scopeType: accessContext.item.scopeType,
      scopeId: accessContext.item.scopeId,
    });

    if (
      !canApproveMemory({
        requesterUserId: params.reviewer.id,
        requesterRole: accessContext.requesterRole,
        organizationId: params.organizationId,
        requesterTeamIds: accessContext.teamIds,
        item: accessContext.item,
      })
    ) {
      logger.info(
        {
          itemId: params.itemId,
          requesterId: params.reviewer.id,
        },
        "[memory] archive: blocked by authorization",
      );
      return null;
    }

    const archived = await MemoryItemModel.transitionStatus({
      id: params.itemId,
      organizationId: params.organizationId,
      newStatus: "archived",
      reviewerId: params.reviewer.id,
    });

    if (archived) {
      reportMemoryReviewed({
        scopeType: archived.scopeType,
        outcome: "archived",
      });
    }

    return archived;
  });
}

export async function unarchive(
  params: ApproveMemoryParams,
): Promise<MemoryItem | null> {
  return withMemorySpan("unarchive", async (span) => {
    const accessContext = await getAccessContext({
      itemId: params.itemId,
      organizationId: params.organizationId,
      requester: params.reviewer,
      teamIds: params.teamIds ?? [],
    });
    if (!accessContext) {
      return null;
    }

    setMemorySpanAttributes(span, {
      scopeType: accessContext.item.scopeType,
      scopeId: accessContext.item.scopeId,
    });

    if (
      !canApproveMemory({
        requesterUserId: params.reviewer.id,
        requesterRole: accessContext.requesterRole,
        organizationId: params.organizationId,
        requesterTeamIds: accessContext.teamIds,
        item: accessContext.item,
      })
    ) {
      logger.info(
        {
          itemId: params.itemId,
          requesterId: params.reviewer.id,
        },
        "[memory] unarchive: blocked by authorization",
      );
      return null;
    }

    const restored = await MemoryItemModel.transitionStatus({
      id: params.itemId,
      organizationId: params.organizationId,
      newStatus: "candidate",
      reviewerId: params.reviewer.id,
    });

    if (restored) {
      reportMemoryReviewed({
        scopeType: restored.scopeType,
        outcome: "unarchived",
      });
    }

    return restored;
  });
}

export async function hardDelete(
  params: ApproveMemoryParams,
): Promise<boolean> {
  return withMemorySpan("delete", async (span) => {
    const accessContext = await getAccessContext({
      itemId: params.itemId,
      organizationId: params.organizationId,
      requester: params.reviewer,
      teamIds: params.teamIds ?? [],
    });
    if (!accessContext) {
      return false;
    }

    setMemorySpanAttributes(span, {
      scopeType: accessContext.item.scopeType,
      scopeId: accessContext.item.scopeId,
    });

    if (
      !canDeleteMemory({
        requesterUserId: params.reviewer.id,
        requesterRole: accessContext.requesterRole,
        organizationId: params.organizationId,
        requesterTeamIds: accessContext.teamIds,
        item: accessContext.item,
      })
    ) {
      logger.info(
        {
          itemId: params.itemId,
          requesterId: params.reviewer.id,
        },
        "[memory] delete: blocked by authorization",
      );
      return false;
    }

    return await MemoryItemModel.hardDelete({
      id: params.itemId,
      organizationId: params.organizationId,
    });
  });
}

export const memoryReviewService = {
  approve,
  reject,
  manualCreate,
  proposeSupersedingEdit,
  archive,
  unarchive,
  hardDelete,
};

// ============================================================================
// Internal helpers
// ============================================================================

async function getAccessContext(params: {
  itemId: string;
  organizationId: string;
  requester: MemoryReviewRequester;
  teamIds: string[];
}): Promise<{
  item: MemoryItem;
  requesterRole: MemoryRequesterRole;
  teamIds: string[];
} | null> {
  const item = await MemoryItemModel.getById({
    id: params.itemId,
    organizationId: params.organizationId,
  });
  if (!item) {
    return null;
  }

  const requesterRole = normalizeMemoryRequesterRole(params.requester.role);
  if (
    !canReadMemory({
      requesterUserId: params.requester.id,
      requesterRole,
      organizationId: params.organizationId,
      requesterTeamIds: params.teamIds,
      item,
    })
  ) {
    return null;
  }

  return {
    item,
    requesterRole,
    teamIds: params.teamIds,
  };
}

function shouldCreateRejectionTombstone(
  reason: MemoryRejectionReason,
): boolean {
  return reason === "manipulative" || reason === "sensitive";
}
