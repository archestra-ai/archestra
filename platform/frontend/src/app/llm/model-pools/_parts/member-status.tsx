"use client";

import { useEffect, useState } from "react";
import type { ModelPool } from "@/lib/model-pools.query";
import { cn } from "@/lib/utils/tailwind";

type SavedMember = ModelPool["members"][number];

/**
 * Whether a member takes traffic now: benched after a failure (with the
 * seconds left and why), off, or healthy. A member not saved yet has none.
 */
export function MemberStatus({
  enabled,
  saved,
}: {
  enabled: boolean;
  saved: SavedMember | null;
}) {
  const secondsLeft = useSecondsLeft(saved?.benchedUntil ?? null);
  if (!saved) return <Pill tone="muted">Not saved yet</Pill>;
  if (!enabled || !saved.enabled) return <Pill tone="muted">Off</Pill>;
  if (secondsLeft > 0) {
    return (
      <Pill tone="bad" title={saved.benchReason ?? undefined}>
        Benched {secondsLeft} s
        {saved.benchReason ? ` · ${saved.benchReason}` : ""}
      </Pill>
    );
  }
  return <Pill tone="ok">Healthy</Pill>;
}

function useSecondsLeft(until: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  if (!until) return 0;
  return Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000));
}

function Pill({
  tone,
  title,
  children,
}: {
  tone: "ok" | "bad" | "muted";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs whitespace-nowrap",
        tone === "ok" &&
          "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
        tone === "bad" &&
          "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
        tone === "muted" && "bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "ok" && "bg-emerald-500",
          tone === "bad" && "bg-red-500",
          tone === "muted" && "bg-muted-foreground/50",
        )}
        aria-hidden="true"
      />
      <span>{children}</span>
    </span>
  );
}
