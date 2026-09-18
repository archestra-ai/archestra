"use client";

import { CircleCheck, Info, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface AgentSetupItem {
  id: string;
  label: string;
  status: "now" | "done";
  action?: ReactNode;
}

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
    seen: items.map(({ id, label }) => ({ id, label })),
  });
  const seen = history.resetKey === resetKey ? history.seen : [];
  const nextSeen = [
    ...seen.map((previous) => {
      const current = items.find(({ id }) => id === previous.id);
      return current ? { id: current.id, label: current.label } : previous;
    }),
    ...items
      .filter(({ id }) => !seen.some((previous) => previous.id === id))
      .map(({ id, label }) => ({ id, label })),
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
  const needsAction = visibleItems.some(({ status }) => status === "now");
  // Outstanding work is the reason the banner exists, so only the settled
  // state can be dismissed.
  if (!needsAction && dismissed) return null;
  const title = needsAction ? "Before this agent can run" : "Ready to run.";

  return (
    <Alert variant={needsAction ? "warning" : "default"} aria-live="polite">
      {needsAction ? <Info /> : <CircleCheck />}
      <AlertTitle className={cn("line-clamp-none", !needsAction && "pr-8")}>
        {title}
      </AlertTitle>
      {!needsAction && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="absolute right-2 top-2 h-6 w-6 shrink-0 p-0 text-muted-foreground"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
      {visibleItems.length > 0 && (
        <AlertDescription className="w-full pt-2">
          <ul className="w-full space-y-2">
            {visibleItems.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">{item.label}</span>
                <Badge variant="outline">
                  {item.status === "done" ? "Done" : "Now"}
                </Badge>
                {item.status !== "done" && item.action && (
                  <div>{item.action}</div>
                )}
              </li>
            ))}
          </ul>
        </AlertDescription>
      )}
    </Alert>
  );
}
