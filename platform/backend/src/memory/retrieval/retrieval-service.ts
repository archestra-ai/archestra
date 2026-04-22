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

  return approvedItems
    .filter((item) => scopesEnabled.includes(item.scopeType))
    .sort(compareMemoryItemsForInjection);
}

export const memoryRetrievalService = {
  listForInjection,
};

// ============================================================================
// Internal helpers
// ============================================================================

function compareMemoryItemsForInjection(a: MemoryItem, b: MemoryItem): number {
  const scopePriorityDelta =
    scopePriority(a.scopeType) - scopePriority(b.scopeType);
  if (scopePriorityDelta !== 0) {
    return scopePriorityDelta;
  }

  const recencyDelta = toTimestamp(b) - toTimestamp(a);
  if (recencyDelta !== 0) {
    return recencyDelta;
  }

  const kindPriorityDelta = kindPriority(a.kind) - kindPriority(b.kind);
  if (kindPriorityDelta !== 0) {
    return kindPriorityDelta;
  }

  return b.id.localeCompare(a.id);
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

function kindPriority(kind: MemoryKind): number {
  return KIND_PRIORITY[kind];
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

const KIND_PRIORITY: Record<MemoryKind, number> = {
  preference: 0,
  profile_fact: 1,
  instruction: 2,
  team_convention: 3,
  org_fact: 4,
};
