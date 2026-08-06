"use client";

import { UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
    // Nothing to pick from in a one-person organization. The option still
    // shows — disabled and explained — so the capability stays discoverable
    // rather than silently absent, which reads as a missing feature.
    disabled: candidates.length === 0,
    disabledLabel: candidates.length === 0 ? "No users available" : undefined,
    disabledReason:
      candidates.length === 0
        ? "There is no one else in your organization to share with yet. Invite someone from Settings → Users."
        : undefined,
    hasCandidates: candidates.length > 0,
  };
}

/**
 * Holds the Users choice selected while it is still empty.
 *
 * "Users" is not a stored scope: a resource shared with named people stays
 * `personal` and carries grants beside it. The choice is therefore read back
 * out of `(scope, userIds)` — which describes a resource that already has
 * grants, but not the moment the option is picked. At that instant the caller
 * has said "Users" and named nobody yet, so `(personal, [])` still reads as
 * plain Personal and the selection snaps back before the picker can be used.
 * This remembers the intent until it is either filled in or abandoned.
 */
export function useUserShareChoice<Scope extends string>({
  scope,
  personalScope,
  userIds,
  onScopeChange,
  onUserIdsChange,
}: {
  scope: Scope;
  /** The stored scope that per-user grants sit beside. */
  personalScope: Scope;
  userIds: string[];
  onScopeChange: (next: Scope) => void;
  /** Omitted by surfaces that cannot persist grants. */
  onUserIdsChange?: (ids: string[]) => void;
}): {
  /** Whether the Users option should read as selected. */
  isUserChoice: boolean;
  selectChoice: (next: Scope | "user") => void;
} {
  const [userChoiceHeld, setUserChoiceHeld] = useState(
    () => scope === personalScope && userIds.length > 0,
  );
  // Any other scope is a real stored answer and wins: holding the intent
  // across it would show Users selected on top of Teams or Organization.
  const isUserChoice =
    scope === personalScope && (userChoiceHeld || userIds.length > 0);

  // Arm the hold once grants are in hand — they can arrive after mount, while
  // the resource is still loading. Without this, removing the last person
  // would drop the picker mid-edit instead of leaving it open to pick again.
  const hasGrants = scope === personalScope && userIds.length > 0;
  useEffect(() => {
    if (hasGrants) setUserChoiceHeld(true);
  }, [hasGrants]);

  const selectChoice = (next: Scope | "user") => {
    if (next === "user") {
      setUserChoiceHeld(true);
      onScopeChange(personalScope);
      return;
    }
    // Leaving Users revokes what it left behind, rather than stranding grants
    // on a resource whose visibility now says something else.
    setUserChoiceHeld(false);
    onUserIdsChange?.([]);
    onScopeChange(next);
  };

  return { isUserChoice, selectChoice };
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
  // Read defensively: this control is mounted inside several dialogs whose
  // suites partially mock the auth and organization query modules, and a
  // visibility picker should degrade to "nobody to share with" rather than
  // crash the dialog around it.
  const currentUserId = useSession()?.data?.user?.id;
  const members = useOrganizationMembers()?.data ?? [];
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
