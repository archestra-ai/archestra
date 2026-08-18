"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import { useBulkUpdateSkillsVisibility } from "@/lib/skills/skill.query";
import { SkillScopeSelector } from "./skill-scope-selector";

/** The visibility fields of one selected skill, as the skills list reports them. */
export type BulkVisibilitySkill = {
  id: string;
  name: string;
  scope: ResourceVisibilityScope;
  teams: Array<{ id: string }>;
  users: Array<{ id: string }>;
};

/**
 * Set one visibility on a selection of skills at once.
 *
 * The form is seeded with what the selection already says when every skill
 * agrees, so the default is a no-op and the common edit ("these five team
 * skills go org-wide") is one click from where it started. A mixed selection
 * has no such answer, so it opens on the narrowest scope and says plainly that
 * applying overwrites what is there.
 *
 * Mount this only while it is open — the scope selector holds transient state
 * for the Users choice, which has to start fresh for each new selection.
 */
export function BulkVisibilityDialog({
  skills,
  open,
  onOpenChange,
  onApplied,
}: {
  skills: BulkVisibilitySkill[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once at least one skill moved, so the caller can drop its selection. */
  onApplied: () => void;
}) {
  const common = commonVisibility(skills);
  const [scope, setScope] = useState<ResourceVisibilityScope>(
    common?.scope ?? "personal",
  );
  const [teamIds, setTeamIds] = useState<string[]>(common?.teamIds ?? []);
  const [userIds, setUserIds] = useState<string[]>(common?.userIds ?? []);
  const bulkUpdate = useBulkUpdateSkillsVisibility();

  // The backend refuses a team-scoped skill with no teams; refuse it here too
  // rather than sending a request that can only come back as an error.
  const canApply = scope !== "team" || teamIds.length > 0;

  const handleApply = () => {
    bulkUpdate.mutate(
      {
        skillIds: skills.map((skill) => skill.id),
        scope,
        teamIds: scope === "team" ? teamIds : [],
        userIds: scope === "personal" ? userIds : [],
      },
      {
        onSuccess: (result) => {
          if (!result) return;
          // A batch where nothing landed keeps the dialog open with the
          // selection intact, so the choice can be corrected rather than
          // rebuilt from scratch.
          if (result.succeeded.length === 0) return;
          onApplied();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit visibility"
      description={
        common
          ? `Applies to ${skillCount(skills.length)}.`
          : `Applies to ${skillCount(skills.length)}, which currently have different visibility. This replaces it for all of them.`
      }
      size="medium"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <SkillScopeSelector
          subject={skills.length === 1 ? "this skill" : "these skills"}
          scope={scope}
          onScopeChange={setScope}
          teamIds={teamIds}
          onTeamIdsChange={setTeamIds}
          userIds={userIds}
          onUserIdsChange={setUserIds}
        />
      </div>

      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          <span>Cancel</span>
        </Button>
        <Button
          disabled={!canApply || bulkUpdate.isPending}
          onClick={handleApply}
        >
          <span>{bulkUpdate.isPending ? "Applying…" : "Apply"}</span>
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}

function skillCount(count: number): string {
  return `${count} ${count === 1 ? "skill" : "skills"}`;
}

/**
 * The visibility every selected skill already shares, or null when they
 * disagree — including on which teams or people they are shared with, since
 * applying replaces those lists wholesale.
 */
function commonVisibility(skills: BulkVisibilitySkill[]): {
  scope: ResourceVisibilityScope;
  teamIds: string[];
  userIds: string[];
} | null {
  const [first, ...rest] = skills;
  if (!first) return null;

  const teamIds = first.teams.map((team) => team.id);
  const userIds = first.users.map((user) => user.id);
  const agrees = rest.every(
    (skill) =>
      skill.scope === first.scope &&
      sameIdSet(
        skill.teams.map((team) => team.id),
        teamIds,
      ) &&
      sameIdSet(
        skill.users.map((user) => user.id),
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
