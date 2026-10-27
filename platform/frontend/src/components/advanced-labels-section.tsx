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
    attributionSource?: "credential" | "billingTeam";
  }
>(function AdvancedLabelsSection(
  {
    labels,
    onLabelsChange,
    className,
    collapsible = false,
    disabled = false,
    attributionSource,
  },
  ref,
) {
  const description = attributionSource
    ? attributionSource === "credential"
      ? "Group LLM spend by these labels. They override billing-team labels and are captured at request start."
      : "Group LLM spend for requests billed to this team. Labels on the authenticated virtual key or OAuth client take priority. Captured at request start."
    : undefined;
  const content = (
    <fieldset disabled={disabled} className="min-w-0">
      <ProfileLabels
        ref={ref}
        description={description}
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
