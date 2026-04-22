import type { MemoryPolicyScope } from "./can-approve";
import { normalizeMemoryRequesterRole } from "./requester-role";

export function canDeleteMemory(params: {
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

  return (
    requesterRole === "admin" && params.item.scopeId === params.organizationId
  );
}
