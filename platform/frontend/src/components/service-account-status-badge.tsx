"use client";

import { Badge } from "@/components/ui/badge";
import {
  ACCOUNT_HEALTH_LABELS,
  type AccountHealth,
  KEY_STATUS_LABELS,
  type KeyStatus,
} from "@/lib/service-account-status";
import { cn } from "@/lib/utils";

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
 */

const HEALTH_CLASSES: Record<AccountHealth, string> = {
  active: "",
  expiring: "text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950",
  "no-usable-keys": "text-red-700 dark:text-red-400 bg-red-100 dark:bg-red-950",
  "no-keys": "",
  disabled: "",
};

const HEALTH_VARIANTS: Record<
  AccountHealth,
  "secondary" | "outline" | "ghost"
> = {
  active: "secondary",
  expiring: "ghost",
  "no-usable-keys": "ghost",
  "no-keys": "outline",
  disabled: "outline",
};

export function AccountHealthBadge({
  health,
  className,
}: {
  health: AccountHealth;
  className?: string;
}) {
  return (
    <Badge
      variant={HEALTH_VARIANTS[health]}
      className={cn(HEALTH_CLASSES[health], className)}
    >
      {ACCOUNT_HEALTH_LABELS[health]}
    </Badge>
  );
}

const KEY_CLASSES: Record<KeyStatus, string> = {
  active: "",
  expiring: "text-amber-700 dark:text-amber-400 bg-amber-100 dark:bg-amber-950",
  expired: "text-red-700 dark:text-red-400 bg-red-100 dark:bg-red-950",
  disabled: "",
};

const KEY_VARIANTS: Record<KeyStatus, "secondary" | "outline" | "ghost"> = {
  active: "secondary",
  expiring: "ghost",
  expired: "ghost",
  disabled: "outline",
};

export function KeyStatusBadge({
  status,
  className,
}: {
  status: KeyStatus;
  className?: string;
}) {
  return (
    <Badge
      variant={KEY_VARIANTS[status]}
      className={cn(KEY_CLASSES[status], className)}
    >
      {KEY_STATUS_LABELS[status]}
    </Badge>
  );
}
