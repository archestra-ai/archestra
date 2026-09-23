"use client";

import { ShieldCheck } from "lucide-react";
import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import type { PolicyBattery } from "@/lib/openappa-batteries.query";
import type { CoveragePosture } from "@/lib/openappa-coverage.query";
import { cn } from "@/lib/utils";
import { BATTERY_STATUS_BADGES } from "./policy-decorations";

export { BATTERY_STATUS_BADGES };

type BatteryStatus = PolicyBattery["status"];

/**
 * The four readings every pill on the page uses. Colour is rationed: red for
 * what is declared and not in force, amber for what nothing judges, and the
 * two good readings stay quiet.
 */
export type CoverageTone = "critical" | "warning" | "info" | "ok";

export const POSTURE_BADGES: Record<
  CoveragePosture,
  { label: string; tone: CoverageTone }
> = {
  not_enforced: { label: "Not enforced", tone: "critical" },
  declared_not_enforced: { label: "Declared, not enforced", tone: "critical" },
  partly_enforced: { label: "Partly enforced", tone: "critical" },
  open: { label: "Open", tone: "warning" },
  guarded: { label: "Guarded", tone: "info" },
  strict: { label: "Strict", tone: "ok" },
};

/** The posture facet's options: one per tone, as the servers and agents endpoints filter. */
export const POSTURE_FILTER_OPTIONS = [
  { value: "not_enforced", label: "Not enforced" },
  { value: "open", label: "Open" },
  { value: "guarded", label: "Guarded" },
  { value: "strict", label: "Strict" },
] as const;

export const BATTERY_STATUS_TONES: Record<BatteryStatus, CoverageTone> = {
  active: "ok",
  missing_credentials: "critical",
  naming_conflict: "critical",
  server_missing: "warning",
  unrouted: "warning",
  refused: "critical",
  unavailable: "critical",
};

/** A pill in one of the page's four tones. */
export function TonedBadge({
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

export function PostureBadge({
  posture,
  className,
}: {
  posture: CoveragePosture;
  className?: string;
}) {
  const { label, tone } = POSTURE_BADGES[posture];
  return (
    <TonedBadge tone={tone} className={className}>
      {tone === "ok" && <ShieldCheck aria-hidden />}
      <span>{label}</span>
    </TonedBadge>
  );
}

/** A battery's status, as the same words and tone everywhere. */
export function BatteryStatusBadge({
  status,
  className,
}: {
  status: BatteryStatus;
  className?: string;
}) {
  return (
    <TonedBadge tone={BATTERY_STATUS_TONES[status]} className={className}>
      <span>{BATTERY_STATUS_BADGES[status].label}</span>
    </TonedBadge>
  );
}

/**
 * Who governs a server or a tool: a battery (in its status' tone), the root
 * text, the catch-all alone, or nothing at all.
 */
export type GovernedBy =
  | { source: "battery"; name: string; status: BatteryStatus }
  | { source: "root"; plural?: boolean }
  | { source: "catchall" }
  | { source: "none" };

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
          <span>{governedBy.plural ? "Root rules" : "Root rule"}</span>
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
    case "none":
      return (
        <Badge
          variant="outline"
          className={cn("text-muted-foreground", className)}
        >
          <span>No rules</span>
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
  info: "secondary",
  ok: "outline",
};

const TONE_CLASSES: Record<CoverageTone, string> = {
  critical: "",
  warning:
    "border-amber-500/50 text-amber-800 dark:border-amber-500/40 dark:text-amber-300",
  info: "",
  ok: "border-emerald-500/50 text-emerald-800 dark:border-emerald-500/40 dark:text-emerald-300",
};
