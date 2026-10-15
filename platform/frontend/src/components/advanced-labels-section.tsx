"use client";

import { forwardRef } from "react";
import { AdvancedSection } from "@/components/advanced-section";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";

/**
 * Labels at the foot of a form, optionally folded into Advanced.
 */
export const AdvancedLabelsSection = forwardRef<
  ProfileLabelsRef,
  {
    labels: ProfileLabel[];
    onLabelsChange: (labels: ProfileLabel[]) => void;
    className?: string;
    collapsible?: boolean;
    disabled?: boolean;
  }
>(function AdvancedLabelsSection(
  { labels, onLabelsChange, className, collapsible = false, disabled = false },
  ref,
) {
  const content = (
    <fieldset disabled={disabled} className="min-w-0">
      <ProfileLabels
        ref={ref}
        labels={labels}
        onLabelsChange={onLabelsChange}
      />
    </fieldset>
  );
  if (!collapsible) return <div className={className}>{content}</div>;
  return (
    <AdvancedSection keepMounted className={className}>
      {content}
    </AdvancedSection>
  );
});
