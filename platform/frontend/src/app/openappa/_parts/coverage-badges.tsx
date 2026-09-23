"use client";

import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import type { PolicyBattery } from "@/lib/openappa-batteries.query";
import { cn } from "@/lib/utils";

type BatteryStatus = PolicyBattery["status"];

/**
 * Policy source tone for the tool breakdown in an entity's Details dialog.
 */
type CoverageTone = "critical" | "warning" | "ok";

const BATTERY_STATUS_TONES: Record<BatteryStatus, CoverageTone> = {
  active: "ok",
  missing_credentials: "critical",
  naming_conflict: "critical",
  server_missing: "warning",
  unrouted: "warning",
  refused: "critical",
  unavailable: "critical",
};

function TonedBadge({
  tone,
  className,
  ...props
}: ComponentProps<typeof Badge> & { tone: CoverageTone }) {
  return (
    <Badge
      data-tone={tone}
      variant={TONE_VARIANTS[tone]}
      className={cn(TONE_CLASSES[tone], className)}
      {...props}
    />
  );
}

/**
 * The source of a tool's matching policy rule, or its fallback.
 */
type GovernedBy =
  | { source: "battery"; name: string; status: BatteryStatus }
  | { source: "root" }
  | { source: "catchall" };

export function GovernedByPill({
  governedBy,
  className,
}: {
  governedBy: GovernedBy;
  className?: string;
}) {
  switch (governedBy.source) {
    case "battery":
      return (
        <TonedBadge
          tone={BATTERY_STATUS_TONES[governedBy.status]}
          className={className}
        >
          <span>{`${governedBy.name} battery`}</span>
        </TonedBadge>
      );
    case "root":
      return (
        <Badge variant="outline" className={className}>
          <span>Root rule</span>
        </Badge>
      );
    case "catchall":
      return (
        <Badge
          variant="outline"
          className={cn("text-muted-foreground", className)}
        >
          <span>Catch-all</span>
        </Badge>
      );
  }
}

const TONE_VARIANTS: Record<
  CoverageTone,
  ComponentProps<typeof Badge>["variant"]
> = {
  critical: "destructive",
  warning: "outline",
  ok: "outline",
};

const TONE_CLASSES: Record<CoverageTone, string> = {
  critical: "",
  warning:
    "border-amber-500/50 text-amber-800 dark:border-amber-500/40 dark:text-amber-300",
  ok: "border-emerald-500/50 text-emerald-800 dark:border-emerald-500/40 dark:text-emerald-300",
};
