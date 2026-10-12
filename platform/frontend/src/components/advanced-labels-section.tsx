"use client";

import { forwardRef } from "react";
import {
  type ProfileLabel,
  ProfileLabels,
  type ProfileLabelsRef,
} from "@/components/agent-labels";

/**
 * Labels at the foot of a form. They used to fold away under "Advanced", but
 * they were its only field, and a collapsible around one field only hides it.
 */
export const AdvancedLabelsSection = forwardRef<
  ProfileLabelsRef,
  {
    labels: ProfileLabel[];
    onLabelsChange: (labels: ProfileLabel[]) => void;
    className?: string;
  }
>(function AdvancedLabelsSection({ labels, onLabelsChange, className }, ref) {
  return (
    <div className={className}>
      <ProfileLabels
        ref={ref}
        labels={labels}
        onLabelsChange={onLabelsChange}
      />
    </div>
  );
});
