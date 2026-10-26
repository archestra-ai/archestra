"use client";

import {
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ModelPool } from "@/lib/model-pools.query";
import { cn } from "@/lib/utils/tailwind";

type SavedMember = ModelPool["members"][number];

/**
 * Whether a member takes traffic now: benched after a failure (with the
 * seconds left and why), off, or healthy. A member not saved yet has none.
 *
 * A glyph beside the word, as the service-account status does: healthy is the
 * usual reading and stays neutral, so only a benched member is coloured.
 */
export function MemberStatus({
  enabled,
  saved,
}: {
  enabled: boolean;
  saved: SavedMember | null;
}) {
  const secondsLeft = useSecondsLeft(saved?.benchedUntil ?? null);
  if (!saved) {
    return <StatusReading icon={CircleDashed}>Not saved yet</StatusReading>;
  }
  if (!enabled || !saved.enabled) {
    return <StatusReading icon={CircleSlash}>Off</StatusReading>;
  }
  if (secondsLeft > 0) {
    const reading = (
      <StatusReading icon={CircleX} danger>
        Benched {secondsLeft} s
      </StatusReading>
    );
    if (!saved.benchReason) return reading;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{reading}</span>
        </TooltipTrigger>
        <TooltipContent>{saved.benchReason}</TooltipContent>
      </Tooltip>
    );
  }
  return <StatusReading icon={CircleCheck}>Healthy</StatusReading>;
}

/** One line for a whole pool: all healthy, or how many are benched. */
export function PoolHealth({ pool }: { pool: ModelPool }) {
  const benched = useBenchedMembers(pool);
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
      {benched.length} benched, {longest} s
    </StatusReading>
  );
}

/** Members benched right now, with their seconds left. */
export function useBenchedMembers(pool: ModelPool) {
  const now = useNow(
    pool.members.some((member) => member.benchedUntil !== null),
  );
  return pool.members.flatMap((member) => {
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
