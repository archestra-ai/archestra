"use client";

import type { CreatedBy } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSession } from "@/lib/auth/auth.query";
import { cn } from "@/lib/utils";

/**
 * Who created an object, rendered the same way everywhere it appears.
 *
 * The question this answers is "who do I go and ask about this", so the cell
 * leads with a name and keeps the email one hover away rather than spending a
 * table column on it. `title` carries the same text as the tooltip so it
 * survives a truncated cell and a copy-paste.
 */
export function CreatedByCell({
  createdBy,
  className,
}: {
  createdBy: CreatedBy | null | undefined;
  className?: string;
}) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

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

  const isSelf = !!currentUserId && createdBy.id === currentUserId;
  // "You" beats your own name here: the column exists to find someone to
  // contact, and the one row you never need to contact is your own.
  const label = isSelf ? "You" : creatorLabel(createdBy);
  const detail = createdBy.email ?? creatorLabel(createdBy);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn("flex min-w-0 items-center gap-2", className)}
          title={detail}
        >
          <Avatar className="h-5 w-5 shrink-0">
            <AvatarFallback className="text-[10px]">
              {getInitials(creatorLabel(createdBy))}
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
 * The "Created by" column, so every table that grows one gets the same header,
 * width and cell. Pass the accessor because the field sits at a different depth
 * per row shape (`row.createdBy`, `row.file.createdBy`, …).
 */
export function createCreatedByColumn<T>({
  accessor,
  header = "Created by",
  size = 120,
}: {
  accessor: (row: T) => CreatedBy | null | undefined;
  /** Override for surfaces where "created" is the wrong verb (e.g. uploads). */
  header?: string;
  /**
   * 120px fits a truncated display name beside the avatar, with the full name
   * and the email on hover. Deliberately modest: `DataTable` sets the table's
   * min-width to the sum of its column sizes, so a wide column here is what
   * pushes a table's Actions column behind a horizontal scroll.
   */
  size?: number;
}): ColumnDef<T> {
  return {
    id: "createdBy",
    header,
    size,
    // Sorting is off because the value is resolved per page rather than
    // ordered in SQL: a client-side sort would silently reorder one page only,
    // which reads as a broken sort rather than an absent one.
    enableSorting: false,
    cell: ({ row }) => <CreatedByCell createdBy={accessor(row.original)} />,
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
