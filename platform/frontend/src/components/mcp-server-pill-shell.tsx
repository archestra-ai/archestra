"use client";

import { Pencil, X } from "lucide-react";
import type * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CatalogDocsLink } from "./catalog-docs-link";

interface McpServerPillShellProps {
  /** Rendered inside the pill trigger, e.g. an `<McpCatalogIcon />`. */
  icon: React.ReactNode;
  displayName: string;
  /** Number shown in the pill as `(count)`. */
  count: number;
  /** No tools selected: the pill goes dashed and grows an adjacent remove button. */
  isEmpty: boolean;
  /** Draws the primary border to mark unsaved/pending selection. */
  highlighted?: boolean;
  /** Muted qualifier shown after the count, e.g. an out-of-environment flag. */
  note?: string;
  description?: string | null;
  docsUrl?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemove: () => void;
  removeAriaLabel?: string;
  triggerTestId?: string;
  /** The popover body below the header (e.g. a `ToolChecklist`). */
  children: React.ReactNode;
}

/**
 * The visual chrome shared by every MCP-server pill — the trigger button, the
 * empty/remove affordance, and the popover header. Callers own the popover body
 * (passed as children) and all data/state, so the agent and app tool editors
 * render an identical pill without sharing their (incompatible) data wiring.
 */
export function McpServerPillShell({
  icon,
  displayName,
  count,
  isEmpty,
  highlighted,
  note,
  description,
  docsUrl,
  open,
  onOpenChange,
  onRemove,
  removeAriaLabel,
  triggerTestId,
  children,
}: McpServerPillShellProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange} modal>
      <div className="flex max-w-full min-w-0 items-center">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "h-8 min-w-0 max-w-full flex-1 gap-1.5 px-3 text-xs",
              isEmpty && "border-dashed opacity-50",
              isEmpty && "rounded-r-none border-r-0",
              highlighted && "border-primary opacity-100",
            )}
            data-testid={triggerTestId}
          >
            {icon}
            <span className="min-w-0 truncate font-medium">{displayName}</span>
            <span className="shrink-0 text-muted-foreground">({count})</span>
            {note ? (
              <span className="shrink-0 font-normal text-muted-foreground">
                {note}
              </span>
            ) : null}
            <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        {isEmpty && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0 rounded-l-none border-dashed opacity-50 hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            aria-label={removeAriaLabel ?? `Remove ${displayName}`}
          >
            <X className="h-3 w-3" />
          </Button>
        )}
      </div>
      <PopoverContent
        className="flex max-h-[min(500px,var(--radix-popover-content-available-height))] w-[420px] max-w-[calc(100vw-2rem)] min-w-0 flex-col overflow-hidden p-0"
        side="bottom"
        align="start"
        sideOffset={8}
        avoidCollisions
        collisionPadding={16}
      >
        <div className="flex min-w-0 shrink-0 items-start justify-between gap-2 border-b p-4">
          <div className="min-w-0 flex-1">
            <h4 className="truncate font-semibold">{displayName}</h4>
            {description && (
              <p className="mt-1 [overflow-wrap:anywhere] text-sm text-muted-foreground">
                {description}
                {docsUrl ? (
                  <>
                    {" "}
                    <CatalogDocsLink
                      url={docsUrl}
                      className="inline-flex items-center gap-1 text-primary hover:underline"
                    />
                  </>
                ) : null}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 shrink-0"
            onClick={() => onOpenChange(false)}
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {children}
      </PopoverContent>
    </Popover>
  );
}
