"use client";

import {
  describeOpenAppaPolicyTarget,
  type OpenAppaPolicyTargetKind,
  openAppaTargetSuggestedPrompts,
} from "@archestra/shared";
import { TriangleAlert } from "lucide-react";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useCoverageEntities } from "@/lib/openappa-coverage.query";
import { OpenAppaOverview } from "./openappa-overview";

/** Loads the selected row's current name instead of trusting URL display text. */
export function OpenAppaTargetConfiguration({
  policyTarget,
}: {
  policyTarget: { kind: OpenAppaPolicyTargetKind; id: string };
}) {
  const entities = useCoverageEntities({
    entityId: policyTarget.id,
    type: policyTarget.kind,
    limit: 1,
    offset: 0,
  });

  if (entities.isLoading || entities.isPlaceholderData)
    return <Skeleton className="h-32 w-full" />;
  if (entities.isLoadingError)
    return (
      <QueryLoadError
        title="Could not load policy target"
        onRetry={() => entities.refetch()}
      />
    );

  const target = entities.data?.data[0];
  if (
    !target ||
    target.id !== policyTarget.id ||
    target.type !== policyTarget.kind
  )
    return (
      <InlineNotice>
        <TriangleAlert />
        <span className="font-medium">Policy target unavailable</span>
        <InlineNoticeText>
          This target is no longer available. Select it again from Overview.
        </InlineNoticeText>
      </InlineNotice>
    );

  return (
    <OpenAppaOverview
      title={`What should the policy do for ${target.name}?`}
      subtitle={`Describe a change for ${describeOpenAppaPolicyTarget(policyTarget.kind, target.name)}.`}
      suggestedPrompts={openAppaTargetSuggestedPrompts(
        policyTarget.kind,
        target.name,
      )}
      policyTarget={policyTarget}
    />
  );
}
