import config from "@/config";
import logger from "@/logging";
import { canApproveMemory } from "@/memory/policy/can-approve";
import { canDeleteMemory } from "@/memory/policy/can-delete";
import { canReadMemory } from "@/memory/policy/can-read";
import {
  type MemoryRequesterRole,
  normalizeMemoryRequesterRole,
} from "@/memory/policy/requester-role";
import { screenCandidateBeforePersist } from "@/memory/policy/screen-candidate-before-persist";
import { buildManualSourceContract } from "@/memory/provenance/source-contract";
import {
  reportMemoryCandidateCreated,
  reportMemoryReviewed,
  reportMemoryReviewPolicyBlocked,
} from "@/memory/telemetry/metrics";
import {
  setMemorySpanAttributes,
  withMemorySpan,
} from "@/memory/telemetry/spans";
import MemoryItemModel from "@/models/memory-item";
import MemoryTombstoneModel from "@/models/memory-tombstone";
import type {
  InsertMemoryItem,
  MemoryItem,
  MemoryPolicyFlag,
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
      | "sourceId"
    >
  > & {
    sourceFuture?: {
      projectId?: string | null;
      workspaceId?: string | null;
      sectionId?: string | null;
    };
  };

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

export type MemoryReviewPolicyErrorReason =
  | "external_context"
  | "sensitive"
  | "high_risk_pii"
  | "instruction_like_high"
  | "tombstone_hit"
  | "high_risk_policy_flags"
  | "quarantined_item";

export class MemoryReviewPolicyError extends Error {
  readonly reason: MemoryReviewPolicyErrorReason;

  constructor(params: {
    reason: MemoryReviewPolicyErrorReason;
    message: string;
  }) {
    super(params.message);
    this.name = "MemoryReviewPolicyError";
    this.reason = params.reason;
  }
}

const HIGH_RISK_APPROVAL_POLICY_FLAGS = new Set<MemoryPolicyFlag>([
  "instruction_like",
  "instruction_like_high",
  "instruction_like_medium",
  "external_context",
]);

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

    if (accessContext.item.status === "quarantined") {
      logger.info(
        {
          itemId: params.itemId,
          requesterId: params.reviewer.id,
        },
        "[memory] approve: blocked — item is quarantined",
      );
      reportMemoryReviewPolicyBlocked("quarantined_item");
      throw new MemoryReviewPolicyError({
        reason: "quarantined_item",
        message:
          "Memory candidate blocked by policy: quarantined items require security review before approval. Use the quarantine review path.",
      });
    }

    if (hasHighRiskApprovalPolicyFlags(accessContext.item.policyFlags)) {
      logger.info(
        {
          itemId: params.itemId,
          requesterId: params.reviewer.id,
          policyFlags: accessContext.item.policyFlags,
        },
        "[memory] approve: blocked by high-risk policy flags",
      );
      reportMemoryReviewPolicyBlocked("high_risk_policy_flags");
      throw new MemoryReviewPolicyError({
        reason: "high_risk_policy_flags",
        message:
          "Memory candidate blocked by policy: high-risk policy flags require additional security review before approval.",
      });
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
        sourceType: approved.sourceType,
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
      // Manipulative content gets a non-expiring tombstone to prevent replay.
      const tombstoneTtlDays =
        params.rejectionReason === "manipulative"
          ? null
          : config.memory.tombstoneTtlDays;
      await MemoryTombstoneModel.record({
        organizationId: accessContext.item.organizationId,
        scopeType: accessContext.item.scopeType,
        scopeId: accessContext.item.scopeId,
        content: accessContext.item.content,
        reason: "rejected",
        ttlDays: tombstoneTtlDays,
      });
    }

    reportMemoryReviewed({
      scopeType: updatedItem.scopeType,
      outcome: "rejected",
      rejectionReason: params.rejectionReason,
      sourceType: updatedItem.sourceType,
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

  const policyScreen = await screenCandidateBeforePersist({
    organizationId: params.organizationId,
    scopeType: params.data.scopeType,
    scopeId: params.data.scopeId,
    content: params.data.content,
    source: "manual_create",
    kind: params.data.kind,
    confidenceBand: params.data.confidenceBand,
  });
  if (!policyScreen.allowed && !policyScreen.quarantine) {
    throw new MemoryReviewPolicyError({
      reason: policyScreen.code,
      message: policyScreen.message,
    });
  }

  const candidateStatus = policyScreen.quarantine ? "quarantined" : "candidate";
  const screenPolicyFlags =
    policyScreen.allowed || policyScreen.quarantine
      ? policyScreen.policyFlags
      : [];

  const mergedPolicyFlags = mergePolicyFlags(
    params.data.policyFlags ?? [],
    screenPolicyFlags,
  );
  const sourceContract = buildManualSourceContract({
    requesterUserId: params.requester.id,
    scopeType: params.data.scopeType,
    scopeId: params.data.scopeId,
    policyFlags: mergedPolicyFlags,
    extractorVersion: params.data.extractorVersion,
    sourceId: params.data.sourceId,
    future: params.data.sourceFuture,
  });

  const created = await MemoryItemModel.create({
    organizationId: params.organizationId,
    scopeType: params.data.scopeType,
    scopeId: params.data.scopeId,
    kind: params.data.kind,
    status: candidateStatus,
    content: params.data.content,
    createdBy: params.requester.id,
    policyFlags: mergedPolicyFlags,
    extractorVersion: params.data.extractorVersion,
    sourceConversationId: params.data.sourceConversationId,
    sourceMessageIds: params.data.sourceMessageIds,
    sourceType: sourceContract.sourceType,
    sourceId: sourceContract.sourceId,
    sourceMetadata: sourceContract.sourceMetadata,
    confidenceBand: params.data.confidenceBand,
    language: params.data.language,
    expiresAt: params.data.expiresAt,
    scores:
      policyScreen.allowed || policyScreen.quarantine
        ? policyScreen.scores
        : undefined,
    classifications:
      policyScreen.allowed || policyScreen.quarantine
        ? policyScreen.classifications
        : undefined,
    scorerVersion:
      policyScreen.allowed || policyScreen.quarantine
        ? policyScreen.scorerVersion
        : undefined,
  });

  reportMemoryCandidateCreated(sourceContract.sourceType);
  return created;
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

  const nextContent = params.patch.content ?? accessContext.item.content;
  const nextKind = params.patch.kind ?? accessContext.item.kind;
  const policyScreen = await screenCandidateBeforePersist({
    organizationId: params.organizationId,
    scopeType: accessContext.item.scopeType,
    scopeId: accessContext.item.scopeId,
    content: nextContent,
    source: "supersede",
    kind: nextKind,
    confidenceBand: accessContext.item.confidenceBand,
  });
  if (!policyScreen.allowed && !policyScreen.quarantine) {
    throw new MemoryReviewPolicyError({
      reason: policyScreen.code,
      message: policyScreen.message,
    });
  }

  const screenPolicyFlags =
    policyScreen.allowed || policyScreen.quarantine
      ? policyScreen.policyFlags
      : [];
  const supersedingStatus = policyScreen.quarantine
    ? "quarantined"
    : "candidate";

  try {
    return await MemoryItemModel.createSupersedingCandidate({
      id: params.itemId,
      organizationId: params.organizationId,
      patch: params.patch,
      requesterId: params.requester.id,
      policyFlags: mergePolicyFlags(
        accessContext.item.policyFlags,
        screenPolicyFlags,
      ),
      status: supersedingStatus,
      scores:
        policyScreen.allowed || policyScreen.quarantine
          ? policyScreen.scores
          : undefined,
      classifications:
        policyScreen.allowed || policyScreen.quarantine
          ? policyScreen.classifications
          : undefined,
      scorerVersion:
        policyScreen.allowed || policyScreen.quarantine
          ? policyScreen.scorerVersion
          : undefined,
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
        sourceType: archived.sourceType,
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
        sourceType: restored.sourceType,
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

export async function quarantineCandidate(
  params: ApproveMemoryParams,
): Promise<MemoryItem | null> {
  return withMemorySpan("quarantine", async (span) => {
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
      return null;
    }

    const quarantined = await MemoryItemModel.transitionStatus({
      id: params.itemId,
      organizationId: params.organizationId,
      newStatus: "quarantined",
      reviewerId: params.reviewer.id,
    });

    if (quarantined) {
      reportMemoryReviewed({
        scopeType: quarantined.scopeType,
        outcome: "quarantined",
        sourceType: quarantined.sourceType,
      });
    }

    return quarantined;
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
  quarantineCandidate,
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

function hasHighRiskApprovalPolicyFlags(
  policyFlags: MemoryPolicyFlag[],
): boolean {
  return policyFlags.some((policyFlag) =>
    HIGH_RISK_APPROVAL_POLICY_FLAGS.has(policyFlag),
  );
}

function mergePolicyFlags(
  currentPolicyFlags: MemoryPolicyFlag[],
  nextPolicyFlags: MemoryPolicyFlag[],
): MemoryPolicyFlag[] {
  return Array.from(new Set([...currentPolicyFlags, ...nextPolicyFlags]));
}
