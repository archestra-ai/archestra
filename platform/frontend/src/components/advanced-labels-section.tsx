"use client";

import { forwardRef, type ReactNode } from "react";
import { AdvancedSection } from "@/components/advanced-section";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";

export const AdvancedLabelsSection = forwardRef<
  ProfileLabelsRef,
  {
    labels: ProfileLabel[];
    onLabelsChange: (labels: ProfileLabel[]) => void;
    className?: string;
    children?: ReactNode;
  }
>(function AdvancedLabelsSection(
  { labels, onLabelsChange, className, children },
  ref,
) {
  return (
    <AdvancedSection className={className}>
      {children}
      <ProfileLabels
        ref={ref}
        labels={labels}
        onLabelsChange={onLabelsChange}
      />
    </AdvancedSection>
  );
});
