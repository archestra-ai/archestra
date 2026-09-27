"use client";

import {
  ArrowUpRight,
  Asterisk,
  BatteryCharging,
  FileCode2,
} from "lucide-react";
import Link from "next/link";
import type { ComponentProps } from "react";
import { Badge } from "@/components/ui/badge";
import type { PolicyBattery } from "@/lib/openappa-batteries.query";
import { cn } from "@/lib/utils/tailwind";
import { batteryDisplayName } from "./battery-display-name";
import { BATTERY_STATUS } from "./battery-status";

type BatteryStatus = PolicyBattery["status"];

/**
 * Policy source tone for the tool breakdown in an entity's Details dialog.
 */
type CoverageTone = "critical" | "warning" | "ok";

/**
 * The source of a tool's matching policy rule, or its fallback.
 */
type GovernedBy =
  | { source: "battery"; name: string; status: BatteryStatus }
  | { source: "root" }
  | { source: "catchall" };

export function GovernedByPill({
  governedBy,
  href,
  line,
  className,
}: {
  governedBy: GovernedBy;
  href?: string;
  line?: number | null;
  className?: string;
}) {
  const tone =
    governedBy.source === "battery"
      ? BATTERY_STATUS[governedBy.status].severity
      : null;
  const Icon =
    governedBy.source === "battery"
      ? BatteryCharging
      : governedBy.source === "root"
        ? FileCode2
        : Asterisk;
  const label =
    governedBy.source === "battery"
      ? batteryDisplayName(governedBy.name)
      : governedBy.source === "root"
        ? "Custom rule"
        : "No rule";
  const content = (
    <>
      <Icon aria-hidden="true" />
      <span>{label}</span>
      {href && (
        <ArrowUpRight aria-hidden="true" className="ml-0.5 opacity-60" />
      )}
    </>
  );
  return (
    <Badge
      asChild={!!href}
      data-tone={tone ?? undefined}
      variant={tone ? TONE_VARIANTS[tone] : "outline"}
      className={cn(
        tone ? TONE_CLASSES[tone] : null,
        governedBy.source === "catchall" && "text-muted-foreground",
        href && "cursor-pointer",
        className,
      )}
    >
      {href ? (
        <Link
          href={href}
          aria-label={`View source for ${label}${line ? ` at line ${line}` : ""}`}
        >
          {content}
        </Link>
      ) : (
        content
      )}
    </Badge>
  );
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
