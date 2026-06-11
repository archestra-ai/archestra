"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useTotalSkillCount } from "./skills-marketplace-step";
import { StepCard } from "./step-card";

/**
 * Whether the connect-step skills option should be offered: feature on, caller
 * is a skill admin, and there is at least one skill to share. Shared between
 * the dedicated skills StepCard and the final connect step's payload builder.
 */
export function useConnectSkills(): { eligible: boolean; totalSkills: number } {
  const skillsEnabled = useFeature("agentSkillsEnabled") === true;
  const { data: canAdminSkills } = useHasPermissions({ skill: ["admin"] });
  const { data: totalSkills } = useTotalSkillCount();
  return {
    eligible:
      skillsEnabled && canAdminSkills === true && (totalSkills ?? 0) > 0,
    totalSkills: totalSkills ?? 0,
  };
}

interface ConnectSkillsStepProps {
  includeSkills: boolean;
  onIncludeChange: (include: boolean) => void;
  expanded: boolean;
  onToggle: (() => void) | undefined;
}

export function ConnectSkillsStep({
  includeSkills,
  onIncludeChange,
  expanded,
  onToggle,
}: ConnectSkillsStepProps) {
  const { eligible, totalSkills } = useConnectSkills();
  if (!eligible) return null;

  return (
    <StepCard
      hideStatus
      title="Install shared skills"
      state={expanded ? "active" : "todo"}
      expanded={expanded}
      onToggle={onToggle}
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Bundle every shared skill into a marketplace your client installs as
          part of the setup command. The link stays valid until you revoke it
          from the Skills page; skills added later won't appear until you
          generate a new command.
        </p>
        <label
          className="flex items-center gap-2 text-sm"
          htmlFor="connect-include-skills"
        >
          <Checkbox
            id="connect-include-skills"
            checked={includeSkills}
            onCheckedChange={(checked) => onIncludeChange(checked === true)}
          />
          {totalSkills === 1
            ? "1 shared skill available — install it with the setup command"
            : `${totalSkills} shared skills available — install them with the setup command`}
        </label>
      </div>
    </StepCard>
  );
}
