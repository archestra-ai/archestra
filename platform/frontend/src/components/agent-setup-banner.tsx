"use client";

import { Circle, CircleCheck, Info, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/tailwind";

export interface AgentSetupItem {
  id: string;
  label: string;
  /** One sentence on why it is needed, under the label. */
  description?: string;
  status: "now" | "done";
  action?: ReactNode;
}

/**
 * What a saved agent still needs before it can run, as a checklist: one row
 * per requirement with its reason and the one action that settles it. Rows
 * resolved while the page is open stay, ticked, so the reader sees progress
 * rather than rows vanishing under them.
 */
export function AgentSetupBanner({
  items,
  showReady = false,
  resetKey,
}: {
  items: AgentSetupItem[];
  showReady?: boolean;
  resetKey?: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [history, setHistory] = useState({
    resetKey,
    seen: items.map(({ id, label, description }) => ({
      id,
      label,
      description,
    })),
  });
  const seen = history.resetKey === resetKey ? history.seen : [];
  const nextSeen = [
    ...seen.map((previous) => {
      const current = items.find(({ id }) => id === previous.id);
      return current
        ? {
            id: current.id,
            label: current.label,
            description: current.description,
          }
        : previous;
    }),
    ...items
      .filter(({ id }) => !seen.some((previous) => previous.id === id))
      .map(({ id, label, description }) => ({ id, label, description })),
  ];
  if (
    history.resetKey !== resetKey ||
    JSON.stringify(nextSeen) !== JSON.stringify(history.seen)
  ) {
    setHistory({ resetKey, seen: nextSeen });
  }
  const visibleItems: AgentSetupItem[] = nextSeen.map(
    (previous) =>
      items.find(({ id }) => id === previous.id) ?? {
        ...previous,
        status: "done",
      },
  );
  if (!visibleItems.length && !showReady) return null;
  const doneCount = visibleItems.filter(
    ({ status }) => status === "done",
  ).length;
  const needsAction = doneCount < visibleItems.length;
  // Outstanding work is the reason the banner exists, so only the settled
  // state can be dismissed.
  if (!needsAction && dismissed) return null;
  const title = needsAction ? "Before this agent can run" : "Ready to run.";

  return (
    <Alert variant={needsAction ? "warning" : "default"} aria-live="polite">
      {needsAction ? <Info /> : <CircleCheck />}
      <AlertTitle
        className={cn(
          "line-clamp-none flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1",
          !needsAction && "pr-8",
        )}
      >
        <span>{title}</span>
        {needsAction && visibleItems.length > 1 && (
          <span className="text-xs font-normal">
            {doneCount} of {visibleItems.length} done
          </span>
        )}
      </AlertTitle>
      {!needsAction && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="absolute right-2 top-2 shrink-0 text-muted-foreground"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
      {visibleItems.length > 0 && (
        <AlertDescription className="w-full pt-2">
          <ul className="w-full divide-y divide-current/15">
            {visibleItems.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-1 last:pb-0"
              >
                {item.status === "done" ? (
                  <CircleCheck className="size-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Circle className="size-4 shrink-0" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1 basis-60">
                  <p className="font-medium">{item.label}</p>
                  {item.description && (
                    <p className="text-xs opacity-80">{item.description}</p>
                  )}
                </div>
                {item.status === "done" ? (
                  <span className="text-xs font-medium">Done</span>
                ) : (
                  item.action && <div className="shrink-0">{item.action}</div>
                )}
              </li>
            ))}
          </ul>
        </AlertDescription>
      )}
    </Alert>
  );
}
