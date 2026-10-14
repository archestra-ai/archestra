"use client";

import { ChevronLeft, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";

/**
 * Header for every view below the agent's settings: a back button named after
 * where it returns, the view's title, and close. The back target is named
 * rather than a bare "Back" because the views nest two deep.
 */
export function QuickEditViewHeader({
  backLabel,
  onBack,
  title,
  icon,
}: {
  backLabel: string;
  onBack: () => void;
  title: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b py-2.5 pr-3 pl-2">
      <Button variant="ghost" size="sm" onClick={onBack} className="min-w-0">
        <ChevronLeft />
        <span className="truncate">{backLabel}</span>
      </Button>
      <span className="text-muted-foreground" aria-hidden="true">
        /
      </span>
      {icon}
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h2>
      <DialogClose asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Close">
          <XIcon />
        </Button>
      </DialogClose>
    </div>
  );
}

/** The bordered footer every quick-edit view shares. */
export function QuickEditFooter({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-2.5">
      {children}
    </div>
  );
}
