"use client";

import type { ChatOpenAppaPolicyTargetMetadata } from "@archestra/shared";
import { TriangleAlert } from "lucide-react";
import {
  type SuggestedPrompt,
  SuggestedPromptPills,
} from "@/app/chat/suggested-prompt-pills";
import { QueryLoadError } from "@/components/query-load-error";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { openAppaSuggestedPrompts } from "@/lib/openappa-chat-prompts";
import { useCoverageEntities } from "@/lib/openappa-coverage.query";

type PillProps = {
  disabled?: boolean;
  onSelect: (prompt: SuggestedPrompt) => void;
  onPreviewChange: (prompt: string | null) => void;
};

/** Suggested prompts on the start screen of a new OpenAPPA policy chat. */
export function OpenAppaSuggestedPrompts({
  target,
  ...pillProps
}: PillProps & { target?: ChatOpenAppaPolicyTargetMetadata }) {
  if (target) return <TargetSuggestedPrompts target={target} {...pillProps} />;
  return (
    <SuggestedPromptPills prompts={openAppaSuggestedPrompts()} {...pillProps} />
  );
}

/** Loads the target's current name instead of trusting URL display text. */
function TargetSuggestedPrompts({
  target,
  ...pillProps
}: PillProps & { target: ChatOpenAppaPolicyTargetMetadata }) {
  const entities = useCoverageEntities({
    entityId: target.id,
    type: target.kind,
    limit: 1,
    offset: 0,
  });

  if (entities.isLoading || entities.isPlaceholderData) return null;
  if (entities.isLoadingError)
    return (
      <QueryLoadError
        title="Could not load policy target"
        onRetry={() => entities.refetch()}
      />
    );

  const entity = entities.data?.data[0];
  if (!entity || entity.id !== target.id || entity.type !== target.kind)
    return (
      <InlineNotice className="max-w-2xl">
        <TriangleAlert />
        <span className="font-medium">Policy target unavailable</span>
        <InlineNoticeText>
          This target is no longer available. Select it again from OpenAPPA
          Overview.
        </InlineNoticeText>
      </InlineNotice>
    );

  return (
    <SuggestedPromptPills
      prompts={openAppaSuggestedPrompts({
        kind: target.kind,
        name: entity.name,
      })}
      {...pillProps}
    />
  );
}
