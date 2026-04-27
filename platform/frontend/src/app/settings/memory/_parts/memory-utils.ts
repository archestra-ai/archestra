import type { archestraApiTypes } from "@shared";

export type MemoryListItem =
  archestraApiTypes.ListMemoryResponses["200"]["data"][number];
export type MemoryScopeType = MemoryListItem["scopeType"];
export type MemoryStatus = MemoryListItem["status"];
export type MemoryKind = MemoryListItem["kind"];
export type MemoryPolicyFlag = MemoryListItem["policyFlags"][number];
export type MemoryRejectionReason = NonNullable<
  MemoryListItem["rejectionReason"]
>;
export type MemoryRole = "admin" | "team-admin" | "member";
export type MemoryStatusTab = Exclude<MemoryStatus, "candidate"> | "candidate";

export const MEMORY_STATUS_TABS: ReadonlyArray<{
  value: MemoryStatusTab;
  label: string;
}> = [
  { value: "candidate", label: "Pending Review" },
  { value: "approved", label: "Approved" },
  { value: "archived", label: "Archived" },
  { value: "rejected", label: "Rejected" },
];

export const MEMORY_REJECTION_REASON_OPTIONS: ReadonlyArray<{
  value: MemoryRejectionReason;
  label: string;
}> = [
  { value: "inaccurate", label: "Inaccurate" },
  { value: "sensitive", label: "Sensitive" },
  { value: "manipulative", label: "Manipulative" },
  { value: "wrong_scope", label: "Wrong Scope" },
  { value: "temporary", label: "Temporary" },
  { value: "duplicate", label: "Duplicate" },
  { value: "vague", label: "Vague" },
  { value: "not_useful", label: "Not Useful" },
  { value: "conflicts_with_existing", label: "Conflicts With Existing" },
  { value: "policy_violation", label: "Policy Violation" },
];

export function getDefaultMemoryStatusTab(
  canApprove: boolean,
): MemoryStatusTab {
  return canApprove ? "candidate" : "approved";
}

export function getMemoryScopeLabel(scopeType: MemoryScopeType): string {
  switch (scopeType) {
    case "user":
      return "User";
    case "team":
      return "Team";
    case "organization":
      return "Organization";
  }
}

export function getMemoryStatusLabel(status: MemoryStatus): string {
  switch (status) {
    case "candidate":
      return "Pending Review";
    case "approved":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "archived":
      return "Archived";
  }
}

export function getMemoryKindLabel(kind: MemoryKind): string {
  switch (kind) {
    case "preference":
      return "Preference";
    case "profile_fact":
      return "Profile Fact";
    case "instruction":
      return "Instruction";
    case "team_convention":
      return "Team Convention";
    case "org_fact":
      return "Org Fact";
  }
}

export function getMemoryPolicyFlagLabel(flag: MemoryPolicyFlag): string {
  switch (flag) {
    case "instruction_like":
      return "Instruction-like";
    case "external_context":
      return "External Context";
    case "source_deleted":
      return "Source evidence removed";
  }
}

export function normalizeMemoryRole(
  role: string | null | undefined,
): MemoryRole {
  const normalizedRole = role?.trim().toLowerCase();
  if (normalizedRole === "admin") {
    return "admin";
  }

  if (
    normalizedRole === "team-admin" ||
    normalizedRole === "team_admin" ||
    normalizedRole === "team admin" ||
    normalizedRole === "editor"
  ) {
    // "editor" is treated as team-admin for memory review permissions in OSS role mapping.
    return "team-admin";
  }

  return "member";
}

export function canApproveMemoryByScope(params: {
  item: Pick<MemoryListItem, "scopeType" | "scopeId">;
  currentUserId: string | null | undefined;
  currentRole: string | null | undefined;
  organizationId: string | null | undefined;
  teamIds: string[];
}): boolean {
  if (!params.currentUserId) {
    return false;
  }

  const role = normalizeMemoryRole(params.currentRole);
  const { item } = params;

  if (item.scopeType === "user") {
    return item.scopeId === params.currentUserId;
  }

  if (item.scopeType === "team") {
    return (
      role === "admin" ||
      (role === "team-admin" && params.teamIds.includes(item.scopeId))
    );
  }

  return role === "admin" && item.scopeId === params.organizationId;
}
