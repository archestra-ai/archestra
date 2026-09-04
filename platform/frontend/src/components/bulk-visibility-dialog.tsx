"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { type ReactNode, useState } from "react";
import { SkillScopeSelector } from "@/app/skills/_parts/skill-scope-selector";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";

/** The visibility fields of one selected row, however its list reports them. */
export type BulkVisibilityItem = {
  id: string;
  scope: ResourceVisibilityScope;
  teams: Array<{ id: string }>;
  users: Array<{ id: string }>;
};

export type BulkVisibilityChange = {
  scope: ResourceVisibilityScope;
  teamIds: string[];
  userIds: string[];
};

/**
 * Set one visibility across a selection.
 *
 * The form is seeded with what the selection already says when every row
 * agrees, so the default is a no-op and the common edit ("these five team
 * skills go org-wide") is one click from where it started. A mixed selection
 * has no such answer, so it opens on the narrowest scope and says plainly that
 * applying overwrites what is there.
 *
 * The resource decides what "apply" means — skills have a bulk route, profiles
 * fan out over their single-item one — so this owns only the form. Mount it
 * only while it is open: the scope selector holds transient state for the
 * Users choice, which has to start fresh for each new selection.
 */
export function BulkVisibilityDialog({
  items,
  noun,
  plural,
  open,
  onOpenChange,
  onApply,
  isPending,
  renderTeamSelectionNotice,
}: {
  items: readonly BulkVisibilityItem[];
  noun: string;
  plural?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Resolves to whether anything actually moved. A batch where nothing landed
   * keeps the dialog open with the selection intact, so the choice can be
   * corrected rather than rebuilt from scratch.
   */
  onApply: (change: BulkVisibilityChange) => Promise<boolean>;
  isPending: boolean;
  /** Optional resource-specific consequence of the staged team selection. */
  renderTeamSelectionNotice?: (teamIds: readonly string[]) => ReactNode;
}) {
  const common = commonVisibility(items);
  const [scope, setScope] = useState<ResourceVisibilityScope>(
    common?.scope ?? "personal",
  );
  const [teamIds, setTeamIds] = useState<string[]>(common?.teamIds ?? []);
  const [userIds, setUserIds] = useState<string[]>(common?.userIds ?? []);

  // The backend refuses a team-scoped resource with no teams; refuse it here
  // too rather than sending a request that can only come back as an error.
  const canApply = scope !== "team" || teamIds.length > 0;

  const count = (n: number) =>
    `${n} ${n === 1 ? noun : (plural ?? `${noun}s`)}`;

  const handleApply = async () => {
    const moved = await onApply({
      scope,
      teamIds: scope === "team" ? teamIds : [],
      userIds: scope === "personal" ? userIds : [],
    });
    if (moved) onOpenChange(false);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit visibility"
      description={
        common
          ? `Applies to ${count(items.length)}.`
          : `Applies to ${count(items.length)}, which currently have different visibility. This replaces it for all of them.`
      }
      size="medium"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <SkillScopeSelector
          subject={
            items.length === 1
              ? `this ${noun}`
              : `these ${plural ?? `${noun}s`}`
          }
          scope={scope}
          onScopeChange={setScope}
          teamIds={teamIds}
          onTeamIdsChange={setTeamIds}
          userIds={userIds}
          onUserIdsChange={setUserIds}
        />
        {scope === "team" && renderTeamSelectionNotice ? (
          <div className="mt-3">{renderTeamSelectionNotice(teamIds)}</div>
        ) : null}
      </div>

      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          <span>Cancel</span>
        </Button>
        <Button disabled={!canApply || isPending} onClick={handleApply}>
          <span>{isPending ? "Applying…" : "Apply"}</span>
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

/**
 * The visibility every selected row already shares, or null when they
 * disagree — including on which teams or people they are shared with, since
 * applying replaces those lists wholesale.
 */
function commonVisibility(
  items: readonly BulkVisibilityItem[],
): BulkVisibilityChange | null {
  const [first, ...rest] = items;
  if (!first) return null;

  const teamIds = first.teams.map((team) => team.id);
  const userIds = first.users.map((user) => user.id);
  const agrees = rest.every(
    (item) =>
      item.scope === first.scope &&
      sameIdSet(
        item.teams.map((team) => team.id),
        teamIds,
      ) &&
      sameIdSet(
        item.users.map((user) => user.id),
        userIds,
      ),
  );
  return agrees ? { scope: first.scope, teamIds, userIds } : null;
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((id) => setB.has(id));
}
