"use client";

import type { CreatedBy } from "@archestra/shared";
import type { DetailFact } from "@/components/detail-facts";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Who created an object, rendered the same way everywhere it appears.
 *
 * The question this answers is "who do I go and ask about this", so it leads
 * with a name and keeps the email one hover away. `title` carries the same text
 * as the tooltip so it survives a truncated cell and a copy-paste.
 *
 * Deliberately presentational — no session lookup, and so no "You" for your own
 * records. Naming the person is just as clear on a detail page showing one
 * record (you know your own name), and reading the session would have made a
 * leaf component depend on a QueryClientProvider being above it, which is a
 * coupling every page test would then have to satisfy.
 */
export function CreatedByCell({
  createdBy,
  className,
}: {
  createdBy: CreatedBy | null | undefined;
  className?: string;
}) {
  if (!createdBy) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("text-muted-foreground", className)}>—</span>
        </TooltipTrigger>
        <TooltipContent>{UNKNOWN_CREATOR_EXPLANATION}</TooltipContent>
      </Tooltip>
    );
  }

  const label = creatorLabel(createdBy);
  const detail = createdBy.email ?? label;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("flex min-w-0 items-center gap-2", className)}
          title={detail}
        >
          <Avatar className="h-5 w-5 shrink-0">
            <AvatarFallback className="text-[10px]">
              {getInitials(label)}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The "Created by" fact, so every detail page and dialog states it identically
 * rather than each inventing its own label and layout.
 *
 * A fact rather than a table column: creator is a property of the one record
 * you already opened, and it is the record you have open that you need to ask
 * somebody about.
 */
export function createdByFact(
  createdBy: CreatedBy | null | undefined,
): DetailFact {
  return {
    label: "Created by",
    value: <CreatedByCell createdBy={createdBy} />,
  };
}

const UNKNOWN_CREATOR_EXPLANATION =
  "No creator recorded — this predates creator tracking, was made automatically, or its author's account was deleted.";

function creatorLabel(createdBy: CreatedBy): string {
  return createdBy.name || createdBy.email || "Unknown user";
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "U";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
