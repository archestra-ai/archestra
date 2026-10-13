"use client";

import { Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * A list row's pin toggle, beside its action buttons: filled while the row is
 * pinned to the top of the list, outlined otherwise.
 */
export function RowPinButton({
  name,
  pinned,
  onToggle,
}: {
  name: string;
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={`${pinned ? "Unpin" : "Pin"} ${name}`}
          aria-pressed={pinned}
          className={pinned ? "text-primary" : "text-muted-foreground"}
          onClick={onToggle}
        >
          <Pin className={pinned ? "h-4 w-4 fill-current" : "h-4 w-4"} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {pinned ? "Unpin" : "Pin to the top of the list"}
      </TooltipContent>
    </Tooltip>
  );
}
