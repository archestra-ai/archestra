"use client";

import {
  type BulkVisibilityItem,
  BulkVisibilityDialog as SharedBulkVisibilityDialog,
} from "@/components/bulk-visibility-dialog";
import { useBulkUpdateSkillsVisibility } from "@/lib/skills/skill.query";

export type BulkVisibilitySkill = BulkVisibilityItem & { name: string };

/**
 * Skills' wiring of the shared visibility dialog. Unlike the other resources
 * this has a real bulk route, so "apply" is one request that reports per-skill
 * outcomes rather than a fan-out.
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
  const bulkUpdate = useBulkUpdateSkillsVisibility();

  return (
    <SharedBulkVisibilityDialog
      items={skills}
      noun="skill"
      open={open}
      onOpenChange={onOpenChange}
      isPending={bulkUpdate.isPending}
      onApply={async (change) => {
        const result = await bulkUpdate.mutateAsync({
          skillIds: skills.map((skill) => skill.id),
          scope: change.scope,
          teamIds: change.teamIds,
          userIds: change.userIds,
        });
        if (!result || result.succeeded.length === 0) return false;
        onApplied();
        return true;
      }}
    />
  );
}
