import type { MemoryPolicyScope } from "./can-approve";
import { normalizeMemoryRequesterRole } from "./requester-role";

export function canReadMemory(params: {
  requesterUserId: string;
  requesterRole: string | null | undefined;
  organizationId: string;
  requesterTeamIds?: string[];
  item: MemoryPolicyScope;
}): boolean {
  const requesterRole = normalizeMemoryRequesterRole(params.requesterRole);
  const requesterTeamIds = params.requesterTeamIds ?? [];

  if (params.item.scopeType === "user") {
    return params.requesterUserId === params.item.scopeId;
  }

  if (params.item.scopeType === "team") {
    return (
      requesterRole === "admin" ||
      (requesterRole === "team-admin" &&
        requesterTeamIds.includes(params.item.scopeId))
    );
  }

  // Rollout-1 hardening: organization scope read is admin-only.
  return (
    requesterRole === "admin" && params.item.scopeId === params.organizationId
  );
}
