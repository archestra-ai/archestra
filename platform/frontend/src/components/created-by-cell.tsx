"use client";

import type { CreatedBy } from "@archestra/shared";
import { Bot } from "lucide-react";
import type { DetailFact } from "@/components/detail-facts";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
 * Renders nothing at all when no creator was recorded, which is a real and
 * ordinary state: an object that predates creator tracking, one the platform
 * made for itself, or one whose author's account has since been deleted. It
 * used to render an em dash carrying a tooltip that listed those three
 * possibilities, which is to say it occupied the header to admit it had no
 * answer — a reader saw "Created by —" and read it as a name that had failed
 * to load. Nothing is what "we don't know" looks like; the surrounding surface
 * drops its label with it.
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
    return null;
  }

  const label = creatorLabel(createdBy);
  const isServiceAccount = createdBy.type === "service_account";
  const detail = isServiceAccount
    ? `${label} · Service account`
    : (createdBy.email ?? label);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("flex min-w-0 items-center gap-2", className)}
          title={detail}
        >
          <Avatar className="h-5 w-5 shrink-0">
            <AvatarFallback className="text-[10px]">
              {isServiceAccount ? (
                <Bot className="size-3.5" aria-hidden="true" />
              ) : (
                getInitials(label)
              )}
            </AvatarFallback>
          </Avatar>
          <span className="min-w-0 truncate">{label}</span>
          {isServiceAccount && (
            <Badge
              variant="outline"
              className="h-4 shrink-0 rounded px-1 py-0 text-[10px] font-normal leading-none text-muted-foreground"
            >
              Service account
            </Badge>
          )}
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
 *
 * `null` when there is no creator to name, so the fact is absent rather than
 * present-and-empty — a "Created by" label standing over a blank value is the
 * same non-answer the em dash was. `DetailFacts` drops nullish entries, so
 * callers list this fact unconditionally alongside the rest.
 */
export function createdByFact(
  createdBy: CreatedBy | null | undefined,
): DetailFact | null {
  if (!createdBy) {
    return null;
  }

  return {
    label: "Created by",
    value: <CreatedByCell createdBy={createdBy} />,
  };
}

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
