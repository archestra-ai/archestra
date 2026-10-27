"use client";

import type { ReactNode } from "react";
import { CLEANUP_INTERVAL_LABELS } from "@/components/limit-cleanup-interval-select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type {
  DefaultUserLimit,
  UserLimitUsage,
} from "@/lib/default-user-limit.query";
import { cn } from "@/lib/utils/tailwind";

export type UserLimitStatus = UserLimitUsage["status"];
export type RosterFilter = "all" | "at" | "near" | "custom" | "none";
export type RosterOpen = {
  filter?: RosterFilter;
  focusId?: string;
  environmentId?: string;
};
export type DotItem = { key: string; node: ReactNode };

export const ALL_ENVIRONMENTS = "__all__";

/** `near` from this percent of a limit; matches the backend's status. */
export const NEAR_LIMIT_PERCENT = 75;

export const STATUS_META: Record<
  UserLimitStatus,
  { label: string; dot: string; ring: string; text: string }
> = {
  ok: {
    label: "Within limit",
    dot: "bg-emerald-500",
    ring: "ring-transparent",
    text: "text-muted-foreground",
  },
  near: {
    label: "Near limit",
    dot: "bg-amber-500",
    ring: "ring-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  at: {
    label: "At limit",
    dot: "bg-destructive",
    ring: "ring-destructive",
    text: "text-destructive",
  },
};

/** Hollow dot for users no limit applies to. */
export const UNLIMITED_DOT = "border border-muted-foreground/70 bg-transparent";

export const LINK_CLASS =
  "rounded-sm underline decoration-dotted underline-offset-4 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none";

/** Ghost buttons sitting on an already-accented row need their own hover. */
export const ROW_ACTION_CLASS =
  "text-muted-foreground hover:bg-background hover:text-foreground dark:hover:bg-background/60";

export function DotList({
  items,
  className,
}: {
  items: (DotItem | null)[];
  className?: string;
}) {
  const shown = items.filter((item): item is DotItem => item !== null);
  return (
    <div
      className={cn("flex flex-wrap items-center gap-x-1.5 gap-y-1", className)}
    >
      {shown.map((item, index) => (
        <span key={item.key} className="inline-flex items-center gap-x-1.5">
          {index > 0 ? <span aria-hidden>·</span> : null}
          {item.node}
        </span>
      ))}
    </div>
  );
}

export function UserAvatar({
  row,
  className,
  ringed,
}: {
  row: Pick<UserLimitUsage, "name" | "image" | "status">;
  className?: string;
  ringed?: boolean;
}) {
  return (
    <Avatar
      className={cn(
        className,
        ringed &&
          row.status !== "ok" &&
          cn(
            "ring-2 ring-offset-2 ring-offset-card",
            STATUS_META[row.status].ring,
          ),
      )}
    >
      {row.image ? <AvatarImage src={row.image} alt="" /> : null}
      <AvatarFallback className="text-xs font-medium">
        {initials(row.name)}
      </AvatarFallback>
    </Avatar>
  );
}

export function statusFor(percent: number): UserLimitStatus {
  if (percent >= 100) return "at";
  if (percent >= NEAR_LIMIT_PERCENT) return "near";
  return "ok";
}

export function intervalLabel(
  interval: DefaultUserLimit["cleanupInterval"] | null | undefined,
) {
  return CLEANUP_INTERVAL_LABELS[interval ?? "calendar_month"];
}

/** "$50" for whole amounts, "$12.50" otherwise. */
export function formatLimit(value: number) {
  return Number.isInteger(value)
    ? `$${value.toLocaleString("en-US")}`
    : formatUsd(value);
}

export function formatUsd(value: number) {
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** "in 3 days", "2 hours ago". */
export function formatRelative(iso: string) {
  const diff = new Date(iso).getTime() - Date.now();
  const minutes = Math.round(diff / 60_000);
  const format = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

export function pluralUsers(count: number) {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "user" : "users"}`;
}

export function firstName(name: string) {
  return name.split(" ")[0] || name;
}

export function modelCountLabel(models: string[] | null | undefined) {
  if (!models?.length) return "All models";
  return models.length === 1 ? models[0] : `${models.length} models`;
}

// ===
// Internal helpers

function initials(name: string) {
  const parts = name.split(" ").filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}
