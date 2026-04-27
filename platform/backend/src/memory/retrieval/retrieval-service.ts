import { getSafetyScoreBucketLabel } from "@/memory/scoring/scorer";
import { reportMemoryRetrieved } from "@/memory/telemetry/metrics";
import MemoryItemModel from "@/models/memory-item";
import type {
  MemoryItem,
  MemoryKind,
  MemoryScopeType,
} from "@/types/memory-item";

export type ListForInjectionParams = {
  userId: string;
  organizationId: string;
  teamIds?: string[];
  scopesEnabled?: MemoryScopeType[];
};

export async function listForInjection(
  params: ListForInjectionParams,
): Promise<MemoryItem[]> {
  const scopesEnabled = normalizeScopesEnabled(params.scopesEnabled);
  const includeOrganizationScope = scopesEnabled.includes("organization");

  const approvedItems = await MemoryItemModel.listApprovedForRetrieval({
    userId: params.userId,
    organizationId: params.organizationId,
    teamIds: params.teamIds ?? [],
    limit: DEFAULT_RETRIEVAL_LIMIT,
    includeOrganizationScope,
  });

  const eligible = approvedItems
    .filter((item) => scopesEnabled.includes(item.scopeType))
    .filter(isEligibleForRetrieval);

  const sorted = eligible.sort(compareMemoryItemsForInjection);

  for (const item of sorted) {
    const bucket = item.scores
      ? getSafetyScoreBucketLabel(item.scores.safetyScore)
      : "unknown";
    reportMemoryRetrieved({
      memoryType: item.kind,
      scopeType: item.scopeType,
      safetyScoreBucket: bucket,
    });
    void MemoryItemModel.incrementRetrievalCount(item.id);
  }

  return sorted;
}

export const memoryRetrievalService = {
  listForInjection,
};

// ============================================================================
// Internal helpers
// ============================================================================

function isEligibleForRetrieval(item: MemoryItem): boolean {
  if (item.status !== "approved") return false;
  // Rollout 1: procedural instructions (kind=instruction) are not injected
  if (item.kind === "instruction") return false;
  if (item.expiresAt && item.expiresAt < new Date()) return false;
  // backward compat: items without scores pass eligibility
  if (!item.scores) return true;
  if (item.scores.safetyScore < 40) return false;
  if (item.scores.injectionRisk > 50) return false;
  return true;
}

function compareMemoryItemsForInjection(a: MemoryItem, b: MemoryItem): number {
  const rankA = computeRetrievalRankScore(a);
  const rankB = computeRetrievalRankScore(b);
  const rankDelta = rankB - rankA;
  if (rankDelta !== 0) return rankDelta;

  const scopePriorityDelta =
    scopePriority(a.scopeType) - scopePriority(b.scopeType);
  if (scopePriorityDelta !== 0) {
    return scopePriorityDelta;
  }

  const recencyDelta = toTimestamp(b) - toTimestamp(a);
  if (recencyDelta !== 0) {
    return recencyDelta;
  }

  return b.id.localeCompare(a.id);
}

function computeRetrievalRankScore(item: MemoryItem): number {
  if (!item.scores) return 50;
  return (
    0.35 * item.scores.salienceScore +
    0.3 * item.scores.confidenceScore +
    0.2 * item.scores.provenanceTrustScore +
    0.15 * item.scores.safetyScore
  );
}

function normalizeScopesEnabled(
  scopesEnabled: MemoryScopeType[] | undefined,
): MemoryScopeType[] {
  if (!scopesEnabled || scopesEnabled.length === 0) {
    // Rollout-1 default keeps injection constrained to user scope.
    return ["user"];
  }

  const allowedScopes = new Set<MemoryScopeType>();
  for (const scopeType of scopesEnabled) {
    if (
      scopeType === "user" ||
      scopeType === "team" ||
      scopeType === "organization"
    ) {
      allowedScopes.add(scopeType);
    }
  }

  if (allowedScopes.size === 0) {
    return ["user"];
  }

  return Array.from(allowedScopes);
}

function scopePriority(scopeType: MemoryScopeType): number {
  return SCOPE_PRIORITY[scopeType];
}

function toTimestamp(item: MemoryItem): number {
  return (
    item.lastVerifiedAt?.getTime() ??
    item.updatedAt.getTime() ??
    item.createdAt.getTime()
  );
}

const DEFAULT_RETRIEVAL_LIMIT = 100;

const SCOPE_PRIORITY: Record<MemoryScopeType, number> = {
  user: 0,
  team: 1,
  organization: 2,
};

// kind priority is used only as tie-breaker when scores are absent
const _KIND_PRIORITY: Record<MemoryKind, number> = {
  preference: 0,
  profile_fact: 1,
  instruction: 2,
  team_convention: 3,
  org_fact: 4,
  episodic_summary: 5,
  tool_usage_preference: 6,
  temporary_context: 7,
};
