"use client";

import { UserRound } from "lucide-react";
import { useMemo } from "react";
import { Label } from "@/components/ui/label";
import { UserSearchableMultiSelect } from "@/components/user-searchable-multi-select";
import type { VisibilityOption } from "@/components/visibility-selector";
import { useSession } from "@/lib/auth/auth.query";
import { useOrganizationMembers } from "@/lib/organization.query";

/**
 * The one definition of "share this with named people", so every surface that
 * offers it says the same thing and picks people the same way.
 *
 * `VisibilitySelector` is only a rendering shell — it shows whatever options
 * array a caller passes and whatever detail panel it puts in `children` — so
 * without this each surface would hand-build its own Users option and its own
 * picker, and they would drift. A surface opts in by spreading
 * {@link useUserShareOption} into its options and rendering
 * {@link UserShareField} when that option is selected.
 */
export function useUserShareOption<Value extends string>(
  value: Value,
): VisibilityOption<Value> & { hasCandidates: boolean } {
  const candidates = useShareCandidates();
  return {
    value,
    label: "Users",
    description: "Share this with selected people",
    icon: UserRound,
    // Nothing to pick from in a one-person organization; the option stays
    // visible but inert so the capability is still discoverable.
    disabled: candidates.length === 0,
    disabledLabel: candidates.length === 0 ? "No users available" : undefined,
    hasCandidates: candidates.length > 0,
  };
}

/** The people picker shown while the Users option is selected. */
export function UserShareField({
  value,
  onValueChange,
  label = "Users",
}: {
  value: string[];
  onValueChange: (userIds: string[]) => void;
  label?: string;
}) {
  const candidates = useShareCandidates();
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <UserSearchableMultiSelect
        value={value}
        onValueChange={onValueChange}
        users={candidates}
        placeholder="Select users"
        searchPlaceholder="Search users..."
        emptyMessage="No users found."
        className="w-full"
      />
    </div>
  );
}

/**
 * Everyone in the organization but the current user, who already reaches their
 * own work — offering to "share" with themselves would be a no-op that reads
 * as a bug.
 */
function useShareCandidates(): Array<{
  userId: string;
  name: string;
  email: string;
}> {
  const { data: session } = useSession();
  const { data: members = [] } = useOrganizationMembers();
  const currentUserId = session?.user?.id;
  return useMemo(
    () =>
      members
        .filter((member) => member.id !== currentUserId)
        .map((member) => ({
          userId: member.id,
          name: member.name,
          email: member.email,
        })),
    [members, currentUserId],
  );
}
