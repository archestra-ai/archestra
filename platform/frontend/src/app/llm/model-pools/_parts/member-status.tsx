"use client";

import {
  CircleCheck,
  CircleSlash,
  CircleX,
  type LucideIcon,
  Snowflake,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ModelPool } from "@/lib/model-pools.query";
import { cn } from "@/lib/utils/tailwind";
import type { SavedMember } from "./pool-form";

/**
 * "Cooling down · 23 s" while a member is skipped after a failure (LiteLLM's
 * word for it), with the reason on hover. Nothing otherwise: a member that
 * answers is the usual case.
 */
export function MemberCooldown({ saved }: { saved: SavedMember | null }) {
  const secondsLeft = useSecondsLeft(saved?.benchedUntil ?? null);
  if (!saved?.enabled || secondsLeft <= 0) return null;
  const badge = (
    <Badge
      variant="outline"
      className="gap-1 border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-300"
    >
      <Snowflake className="size-3" aria-hidden="true" />
      <span>Cooling down · {secondsLeft} s</span>
    </Badge>
  );
  if (!saved.benchReason) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">{badge}</span>
      </TooltipTrigger>
      <TooltipContent>{saved.benchReason}</TooltipContent>
    </Tooltip>
  );
}

/** One line for a whole pool: all healthy, or how many are benched. */
export function PoolHealth({ pool }: { pool: ModelPool }) {
  const benched = useBenchedMembers(pool.members);
  const on = pool.members.filter((member) => member.enabled).length;
  if (on === 0) {
    return <StatusReading icon={CircleSlash}>Every member off</StatusReading>;
  }
  if (benched.length === 0) {
    return <StatusReading icon={CircleCheck}>All healthy</StatusReading>;
  }
  const longest = Math.max(...benched.map((member) => member.secondsLeft));
  return (
    <StatusReading icon={CircleX} danger>
      {benched.length} cooling down, {longest} s
    </StatusReading>
  );
}

/**
 * "· 2 cooling down" on a folded order, whose rows and their "Cooling down"
 * badges are hidden. Nothing while its members are all answering.
 */
export function FoldedCooldown({ saved }: { saved: SavedMember[] }) {
  const benched = useBenchedMembers(saved);
  if (benched.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
      <span aria-hidden="true">·</span>
      <span className="flex items-center gap-1 text-sky-700 dark:text-sky-300">
        <Snowflake className="size-3" aria-hidden="true" />
        <span>{benched.length} cooling down</span>
      </span>
    </span>
  );
}

/** Members benched right now, with their seconds left. */
function useBenchedMembers(members: SavedMember[]) {
  const now = useNow(members.some((member) => member.benchedUntil !== null));
  return members.flatMap((member) => {
    if (!member.enabled || !member.benchedUntil) return [];
    const secondsLeft = Math.ceil(
      (new Date(member.benchedUntil).getTime() - now) / 1000,
    );
    return secondsLeft > 0 ? [{ ...member, secondsLeft }] : [];
  });
}

function useSecondsLeft(until: string | null): number {
  const now = useNow(until !== null);
  if (!until) return 0;
  return Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000));
}

/** The time, ticking every second while `ticking`. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function StatusReading({
  icon: Icon,
  danger = false,
  children,
}: {
  icon: LucideIcon;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-xs",
        danger ? "text-red-700 dark:text-red-400" : "text-muted-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}
