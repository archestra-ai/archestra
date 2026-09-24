"use client";

import {
  type OpenAppaPolicyTargetKind,
  openAppaTargetChatSubtitle,
  openAppaTargetChatTitle,
  openAppaTargetSuggestedPrompts,
} from "@archestra/shared";
import { TriangleAlert } from "lucide-react";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useCoverageEntities } from "@/lib/openappa-coverage.query";
import { OpenAppaOverview } from "./openappa-overview";

/** Loads the selected row's current name instead of trusting URL display text. */
export function OpenAppaTargetConfiguration({
  policyTarget,
}: {
  policyTarget: { kind: OpenAppaPolicyTargetKind; id: string };
}) {
  const registryRead = useHasPermissions({ mcpRegistry: ["read"] });
  const entities = useCoverageEntities({
    entityId: policyTarget.id,
    type: policyTarget.kind,
    limit: 1,
    offset: 0,
  });

  if (
    entities.isLoading ||
    entities.isPlaceholderData ||
    (policyTarget.kind === "mcp_server" && registryRead.isPending)
  )
    return <Skeleton className="h-32 w-full" />;
  if (policyTarget.kind === "mcp_server" && registryRead.isError)
    return (
      <QueryLoadError
        title="Could not check registry access"
        onRetry={() => registryRead.refetch()}
      />
    );
  if (policyTarget.kind === "mcp_server" && registryRead.data !== true)
    return (
      <InlineNotice>
        <TriangleAlert />
        <span className="font-medium">Registry access required</span>
        <InlineNoticeText>
          You need permission to read the MCP registry to configure this server
          with chat.
        </InlineNoticeText>
      </InlineNotice>
    );
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
      title={openAppaTargetChatTitle(target.name)}
      subtitle={openAppaTargetChatSubtitle(policyTarget.kind, target.name)}
      suggestedPrompts={openAppaTargetSuggestedPrompts(
        policyTarget.kind,
        target.name,
      )}
      policyTarget={policyTarget}
    />
  );
}
