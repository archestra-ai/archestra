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
  }
>(function AdvancedLabelsSection(
  { labels, onLabelsChange, className, collapsible = false },
  ref,
) {
  const content = (
    <ProfileLabels ref={ref} labels={labels} onLabelsChange={onLabelsChange} />
  );
  if (!collapsible) return <div className={className}>{content}</div>;
  return (
    <AdvancedSection keepMounted className={className}>
      {content}
    </AdvancedSection>
  );
});
