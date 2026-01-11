"use client";

import type { ModelCapability } from "@shared";
import { CAPABILITY_INFO } from "@shared";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ModelCapabilityBadgeProps {
  capability: ModelCapability;
  className?: string;
}

export function ModelCapabilityBadge({
  capability,
  className,
}: ModelCapabilityBadgeProps) {
  const info = CAPABILITY_INFO[capability];
  if (!info) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={cn(
            "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium",
            className,
          )}
        >
          <span className="text-muted-foreground">{info.label}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        <p>{info.description}</p>
      </TooltipContent>
    </Tooltip>
  );
}

interface ModelCapabilitiesListProps {
  capabilities: ModelCapability[];
  className?: string;
  maxDisplay?: number;
}

export function ModelCapabilitiesList({
  capabilities,
  className,
  maxDisplay = 3,
}: ModelCapabilitiesListProps) {
  if (!capabilities?.length) return null;
  const sortedCapabilities = capabilities
    .map((cap) => ({ cap, priority: CAPABILITY_INFO[cap]?.priority || 999 }))
    .sort((a, b) => a.priority - b.priority)
    .map(({ cap }) => cap);

  const displayCapabilities = sortedCapabilities.slice(0, maxDisplay);
  const hiddenCount = sortedCapabilities.length - maxDisplay;

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {displayCapabilities.map((capability) => (
        <ModelCapabilityBadge key={capability} capability={capability} />
      ))}
      {hiddenCount > 0 && (
        <Badge variant="secondary" className="text-xs">
          +{hiddenCount} more
        </Badge>
      )}
    </div>
  );
}
