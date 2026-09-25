"use client";

import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Clock,
  type LucideIcon,
  TriangleAlert,
} from "lucide-react";
import {
  ACCOUNT_HEALTH_LABELS,
  type AccountHealth,
  KEY_STATUS_LABELS,
  type KeyStatus,
} from "@/lib/service-account-status";
import { cn } from "@/lib/utils/tailwind";

/**
 * The one rendering of service-account and key state, shared by the list, the
 * cards and the detail page so a reader learns the vocabulary once.
 *
 * Colour is rationed on purpose. Only two readings are coloured: amber for a
 * key about to lapse, red for an account that someone believes works and does
 * not. "Active" stays neutral because it is the majority of any list, and a
 * page of green badges says nothing while making the two that matter harder to
 * find. "Disabled" and "No keys" are deliberate or unfinished, not faults, so
 * they stay neutral too.
 *
 * A glyph beside the word, rather than a filled pill around it. Every state
 * had the same chip silhouette, so a column of them read as decoration and the
 * eye had to fall back on colour alone to find the row that needed attention.
 * The glyph differs per state, which gives the reading a second channel that
 * survives both a greyscale print and the colour vision most affected by an
 * amber/red pairing. Dropping the fill also stops a dense table looking like a
 * column of buttons.
 */

type StatusTone = "neutral" | "warning" | "danger";

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "text-muted-foreground",
  warning: "text-amber-700 dark:text-amber-400",
  danger: "text-red-700 dark:text-red-400",
};

const HEALTH_PRESENTATION: Record<
  AccountHealth,
  { icon: LucideIcon; tone: StatusTone }
> = {
  active: { icon: CircleCheck, tone: "neutral" },
  expiring: { icon: Clock, tone: "warning" },
  // The only reading that means "someone believes this works and it does not".
  "no-usable-keys": { icon: TriangleAlert, tone: "danger" },
  // Unfinished rather than broken, so a hollow outline rather than an alarm.
  "no-keys": { icon: CircleDashed, tone: "neutral" },
  disabled: { icon: CircleSlash, tone: "neutral" },
};

export function AccountHealthBadge({
  health,
  className,
}: {
  health: AccountHealth;
  className?: string;
}) {
  const { icon, tone } = HEALTH_PRESENTATION[health];
  return (
    <StatusReading icon={icon} tone={tone} className={className}>
      {ACCOUNT_HEALTH_LABELS[health]}
    </StatusReading>
  );
}

const KEY_PRESENTATION: Record<
  KeyStatus,
  { icon: LucideIcon; tone: StatusTone }
> = {
  active: { icon: CircleCheck, tone: "neutral" },
  expiring: { icon: Clock, tone: "warning" },
  expired: { icon: CircleX, tone: "danger" },
  disabled: { icon: CircleSlash, tone: "neutral" },
};

export function KeyStatusBadge({
  status,
  className,
}: {
  status: KeyStatus;
  className?: string;
}) {
  const { icon, tone } = KEY_PRESENTATION[status];
  return (
    <StatusReading icon={icon} tone={tone} className={className}>
      {KEY_STATUS_LABELS[status]}
    </StatusReading>
  );
}

// === Internal helpers

function StatusReading({
  icon: Icon,
  tone,
  className,
  children,
}: {
  icon: LucideIcon;
  tone: StatusTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-sm",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {children}
    </span>
  );
}
