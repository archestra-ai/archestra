"use client";

import { EnvironmentMultiSelector } from "@/components/environment-multi-selector";
import type { SkillDraft } from "./skill-draft";
import { SkillScopeSelector } from "./skill-scope-selector";

/**
 * The access half of a skill: who can see it (scope, teams, people) and which
 * environments' agents may use it. Controlled by the caller's draft.
 */
export function SkillAccessFields({
  draft,
  onChange,
}: {
  draft: SkillDraft;
  onChange: (patch: Partial<SkillDraft>) => void;
}) {
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
      <EnvironmentMultiSelector
        value={draft.environmentIds}
        onChange={(environmentIds) => onChange({ environmentIds })}
        resource="skill"
        hideWhenNoEnvironments
        helpText="Restrict this skill to specific environments. Leave empty to make it available to agents in every environment."
      />
    </div>
  );
}
