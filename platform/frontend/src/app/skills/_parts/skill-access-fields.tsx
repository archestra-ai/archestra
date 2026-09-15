"use client";

import { forwardRef } from "react";
import {
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import { EnvironmentSelector } from "@/components/environment-selector";
import type { SkillDraft } from "./skill-draft";
import { SkillScopeSelector } from "./skill-scope-selector";

/**
 * The access half of a skill: who can see it (scope, teams, people) and which
 * environments' agents may use it. Controlled by the caller's draft.
 */
export const SkillAccessFields = forwardRef<
  ProfileLabelsRef,
  {
    draft: SkillDraft;
    onChange: (patch: Partial<SkillDraft>) => void;
  }
>(function SkillAccessFields({ draft, onChange }, ref) {
  return (
    <div className="flex flex-col gap-4">
      <SkillScopeSelector
        scope={draft.scope}
        onScopeChange={(scope) => onChange({ scope })}
        teamIds={draft.teamIds}
        onTeamIdsChange={(teamIds) => onChange({ teamIds })}
        userIds={draft.userIds}
        onUserIdsChange={(userIds) => onChange({ userIds })}
      />
      <EnvironmentSelector
        mode="multiple"
        value={draft.environmentIds}
        onChange={(environmentIds) => onChange({ environmentIds })}
        resource="skill"
        hideWhenOnlyDefault
        helpText="Restrict this skill to specific environments. Leave empty to make it available to agents in every environment."
      />
      <ProfileLabels
        ref={ref}
        labels={draft.labels}
        onLabelsChange={(labels) => onChange({ labels })}
      />
    </div>
  );
});
