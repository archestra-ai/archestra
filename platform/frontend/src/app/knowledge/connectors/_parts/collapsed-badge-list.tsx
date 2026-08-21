// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

"use client";

import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const MAX_VISIBLE_ITEMS = 2;

type CollapsedBadgeItem = {
  /** React key, stable across renders. */
  id: string;
  label: string;
  /** Hover title on the visible badge. Defaults to the label. */
  title?: string;
  /** Leading glyph, so the kind of entry reads before the text does. */
  icon?: LucideIcon;
  /** Badge palette — e.g. one of the shared scope styles. */
  className?: string;
};

/**
 * The list-in-a-table-cell rendering the connector tables share: the first two
 * items as outline badges, everything past that collapsed behind a "+N more"
 * badge whose tooltip lists the rest (scrollable — an auto-sync audience can
 * carry hundreds). Callers render their own empty state, because what "no
 * items" means differs per column: a document with no ACL is fail-closed, a
 * member with no groups is merely unremarkable.
 */
export function CollapsedBadgeList({ items }: { items: CollapsedBadgeItem[] }) {
  const visible = items.slice(0, MAX_VISIBLE_ITEMS);
  const hidden = items.slice(MAX_VISIBLE_ITEMS);

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map(({ id, label, title, icon: Icon, className }) => (
        <Badge
          key={id}
          variant="outline"
          className={cn("max-w-full gap-1 text-xs", className)}
          title={title ?? label}
        >
          {Icon && <Icon className="h-3 w-3 shrink-0" />}
          <span className="truncate">{label}</span>
        </Badge>
      ))}
      {hidden.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="cursor-default text-xs">
              +{hidden.length} more
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-80">
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {hidden.map(({ id, label }) => (
                <div key={id}>{label}</div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
