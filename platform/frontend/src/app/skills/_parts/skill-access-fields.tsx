"use client";

import { forwardRef } from "react";
import {
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import { EnvironmentMultiSelector } from "@/components/environment-multi-selector";
import { InitialResourcePermissions } from "@/components/initial-resource-permissions";
import type { SkillDraft } from "./skill-draft";

/**
 * The access half of a skill: initial grants and which
 * environments' agents may use it. Controlled by the caller's draft.
 */
export const SkillAccessFields = forwardRef<
  ProfileLabelsRef,
  {
    draft: SkillDraft;
    creating?: boolean;
    onChange: (patch: Partial<SkillDraft>) => void;
  }
>(function SkillAccessFields({ draft, onChange, creating = false }, ref) {
  return (
    <div className="flex flex-col gap-4">
      {creating && (
        <InitialResourcePermissions
          resource="skill"
          grants={draft.initialGrants ?? []}
          onChange={(initialGrants) => onChange({ initialGrants })}
        />
      )}
      <EnvironmentMultiSelector
        value={draft.environmentIds}
        onChange={(environmentIds) => onChange({ environmentIds })}
        resource="skill"
        hideWhenNoEnvironments
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
