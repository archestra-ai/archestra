import { TriangleAlertIcon } from "lucide-react";
import type * as React from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";

/**
 * Amber warning glyph for the composer toolbar. Hover names the problem; the
 * full guidance opens from a click/tap/Enter Popover on a real button, since a
 * hover-only overlay is unreachable by keyboard and unreliable on touch.
 * Inline in the toolbar (not a banner) so toggling models never shifts the
 * composer layout.
 */
export function ComposerWarningIcon({
  label,
  children,
}: {
  /** Short name of the problem: the button's accessible name and hover text. */
  label: string;
  /** The guidance shown when the icon is opened. */
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <UnstyledButton
              type="button"
              aria-label={label}
              className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-amber-500/80 transition-colors hover:text-amber-500"
            >
              <TriangleAlertIcon className="size-3.5" />
            </UnstyledButton>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        sideOffset={4}
        className="w-auto max-w-60 p-3 text-xs"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
