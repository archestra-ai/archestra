"use client";

import { CircleCheck, Info, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineNotice } from "@/components/ui/inline-notice";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";

export interface AgentSetupItem {
  id: string;
  label: string;
  /** Extra context shown on hover, or inline when there is no action. */
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
  const title = needsAction ? "Connect to start" : "Ready to run.";

  return (
    <InlineNotice
      variant={needsAction ? "neutral" : "success"}
      role="status"
      aria-live="polite"
      className="gap-x-4 gap-y-2"
    >
      {needsAction ? <Info aria-hidden /> : <CircleCheck aria-hidden />}
      <span className="font-medium">{title}</span>
      {visibleItems.length > 0 && (
        <ul className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-2">
          {visibleItems.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-2">
              {item.status === "done" && (
                <CircleCheck className="size-3.5" aria-hidden />
              )}
              <div className="min-w-0">
                {item.description && item.action ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <UnstyledButton
                        aria-label={`About ${item.label}`}
                        className="cursor-help"
                      >
                        {item.label}
                      </UnstyledButton>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-sm">
                      {item.description}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <span>{item.label}</span>
                )}
                {item.description && !item.action && item.status !== "done" && (
                  <p className="text-muted-foreground">{item.description}</p>
                )}
              </div>
              {item.status === "done" ? (
                <span className="sr-only">Done</span>
              ) : (
                item.action
              )}
            </li>
          ))}
        </ul>
      )}
      {!needsAction && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
        >
          <X />
        </Button>
      )}
    </InlineNotice>
  );
}
