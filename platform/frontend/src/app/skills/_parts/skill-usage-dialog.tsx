"use client";

import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import type { SkillUsageReference } from "@/lib/skills/skill.query";
import {
  SKILL_USAGE_WINDOW_FALLBACK_DAYS,
  SkillUsagePanel,
} from "./skill-usage-panel";

/**
 * Usage analytics for a skill that has no page of its own — one served by an
 * MCP server, which is listed on the skills page but never routed to.
 *
 * A skill stored here reads its usage on `/skills/[id]`'s Usage tab instead,
 * which is the same panel with room to breathe.
 */
export function SkillUsageDialog({
  skillRef,
  skillName,
  open,
  onOpenChange,
}: {
  skillRef: SkillUsageReference;
  skillName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <StandardDialog
      open={open}
      onOpenChange={onOpenChange}
      className="max-w-3xl"
      title={`Usage of "${skillName}"`}
      description={`Who activated this skill over the last ${SKILL_USAGE_WINDOW_FALLBACK_DAYS} days, and how often.`}
      footer={
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
        >
          Close
        </Button>
      }
    >
      <SkillUsagePanel skillRef={skillRef} enabled={open} />
    </StandardDialog>
  );
}
