"use client";

import {
  FileText,
  ImageIcon,
  Layers,
  Mic,
  Settings2,
  Type,
  Video,
} from "lucide-react";
import {
  NoToolsBadge,
  NotRecommendedForAgentsBadge,
  UnknownCapabilitiesBadge,
} from "@/components/model-badges";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ModelCapabilities } from "@/lib/llm-models.query";
import { cn, formatContextLength } from "@/lib/utils";

export function ModelCapabilityBadges({
  capabilities,
  showTextInput = false,
}: {
  capabilities?: ModelCapabilities;
  showTextInput?: boolean;
}) {
  const hasText =
    showTextInput && capabilities?.inputModalities?.includes("text");
  const hasVision = capabilities?.inputModalities?.includes("image");
  const hasAudio = capabilities?.inputModalities?.includes("audio");
  const hasVideo = capabilities?.inputModalities?.includes("video");
  const hasPdf = capabilities?.inputModalities?.includes("pdf");
  const hasToolCalling = capabilities?.supportsToolCalling;
  const lacksToolCalling = capabilities?.supportsToolCalling === false;
  const notRecommended = capabilities?.recommendedForAgents === false;
  const hasAnyCapability =
    hasText || hasVision || hasAudio || hasVideo || hasPdf || hasToolCalling;
  const hasCapabilityData =
    capabilities != null &&
    (capabilities.inputModalities != null ||
      capabilities.supportsToolCalling != null);

  if (!hasCapabilityData) return <UnknownCapabilitiesBadge />;
  if (!hasAnyCapability && !lacksToolCalling && !notRecommended) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex max-w-full flex-wrap items-center justify-end gap-0.5">
        {hasText && <CapabilityIcon icon={Type} label="Supports text input" />}
        {hasVision && (
          <CapabilityIcon icon={ImageIcon} label="Supports vision (images)" />
        )}
        {hasAudio && <CapabilityIcon icon={Mic} label="Supports audio input" />}
        {hasVideo && (
          <CapabilityIcon icon={Video} label="Supports video input" />
        )}
        {hasPdf && (
          <CapabilityIcon icon={FileText} label="Supports PDF input" />
        )}
        {notRecommended && <NotRecommendedForAgentsBadge />}
        {lacksToolCalling && <NoToolsBadge />}
        {hasToolCalling && (
          <CapabilityIcon icon={Settings2} label="Supports tool calling" />
        )}
      </div>
    </TooltipProvider>
  );
}

export function ModelContextLengthIndicator({
  contextLength,
}: {
  contextLength: number | null | undefined;
}) {
  if (!contextLength) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={`${contextLength.toLocaleString()} token context window`}
            className="inline-flex items-center gap-0.5 font-mono text-xs text-muted-foreground"
          >
            <Layers className="size-3" />
            <span>{formatContextLength(contextLength)}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {contextLength.toLocaleString()} token context window
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function CapabilityIcon({
  icon: Icon,
  label,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          className={cn(
            "inline-flex size-4 items-center justify-center rounded-sm bg-muted/50",
            className,
          )}
        >
          <Icon className="size-2.5 text-muted-foreground" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
