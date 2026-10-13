"use client";

import { forwardRef } from "react";
import { AdvancedSection } from "@/components/advanced-section";
import {
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";
import { EnvironmentSelector } from "@/components/environment-selector";
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
      {/* Environments and labels are refinements: they wait under Advanced
          unless already set. */}
      <AdvancedSection
        defaultOpen={draft.labels.length > 0 || draft.environmentIds.length > 0}
        // Alone in its section on an edit: the section already draws the rule.
        className={creating ? undefined : "border-t-0 pt-0"}
      >
        <div className="flex flex-col gap-4">
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
      </AdvancedSection>
    </div>
  );
});
