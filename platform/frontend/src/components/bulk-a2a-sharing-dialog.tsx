"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { useState } from "react";
import { A2aRemoteAgentScopeSelector } from "@/components/a2a-remote-agent-scope-selector";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";

/** The visibility fields of one selected row, however its list reports them. */
type BulkVisibilityItem = {
  id: string;
  scope: ResourceVisibilityScope;
  teams: Array<{ id: string }>;
  users: Array<{ id: string }>;
};

type BulkVisibilityChange = {
  scope: ResourceVisibilityScope;
  teamIds: string[];
  userIds: string[];
};

type BulkVisibilitySelectorProps = BulkVisibilityChange & {
  subject: string;
  onScopeChange: (scope: ResourceVisibilityScope) => void;
  onTeamIdsChange: (ids: string[]) => void;
  onUserIdsChange: (ids: string[]) => void;
};

/** Bulk discovery sharing for the separate remote A2A agent API. */
export function BulkA2aSharingDialog({
  items,
  noun,
  plural,
  open,
  onOpenChange,
  onApply,
  isPending,
  applyDisabled = false,
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
  applyDisabled?: boolean;
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
  const subject =
    items.length === 1 ? `this ${noun}` : `these ${plural ?? `${noun}s`}`;
  const selectorProps: BulkVisibilitySelectorProps = {
    subject,
    scope,
    teamIds,
    userIds,
    onScopeChange: setScope,
    onTeamIdsChange: setTeamIds,
    onUserIdsChange: setUserIds,
  };

  const handleApply = async () => {
    if (applyDisabled) return;
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
      title="Share remote agents"
      description={
        common
          ? `Applies to ${count(items.length)}.`
          : `Applies to ${count(items.length)}, which currently have different sharing settings. This replaces sharing for all of them.`
      }
      size="medium"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <A2aRemoteAgentScopeSelector {...selectorProps} />
      </div>

      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          <span>Cancel</span>
        </Button>
        <Button
          disabled={!canApply || isPending || applyDisabled}
          onClick={handleApply}
        >
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
