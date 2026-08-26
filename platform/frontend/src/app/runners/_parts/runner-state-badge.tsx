"use client";

import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const VARIANTS: Record<
  string,
  {
    label: string;
    variant: "default" | "secondary" | "destructive" | "outline";
  }
> = {
  pending: { label: "Pending", variant: "outline" },
  provisioning: { label: "Starting", variant: "secondary" },
  running: { label: "Running", variant: "default" },
  stopping: { label: "Stopping", variant: "secondary" },
  stopped: { label: "Stopped", variant: "outline" },
  failed: { label: "Failed", variant: "destructive" },
};

export function RunnerStateBadge({
  state,
  statusReason,
}: {
  state: string;
  statusReason?: string | null;
}) {
  const config = VARIANTS[state] ?? {
    label: state,
    variant: "outline" as const,
  };
  const badge = <Badge variant={config.variant}>{config.label}</Badge>;

  // The reason is why a session ended, which is the first thing anyone wants
  // when they see "Failed" — so it rides along rather than living a click away.
  if (!statusReason) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent className="max-w-sm">{statusReason}</TooltipContent>
    </Tooltip>
  );
}
