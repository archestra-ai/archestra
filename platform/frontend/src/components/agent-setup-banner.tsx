"use client";

import { CircleCheck, Info } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

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
  const title = needsAction ? "Before this agent can run" : "Ready to run.";

  return (
    <Alert variant={needsAction ? "warning" : "default"} aria-live="polite">
      {needsAction ? <Info /> : <CircleCheck />}
      <AlertTitle className="line-clamp-none">{title}</AlertTitle>
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
