"use client";

import { Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  StandardDialog,
  type StandardDialogProps,
} from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/** Keep repository, search and actions in view while the import list scrolls. */
export function ImportSelectionDialog({
  selecting,
  ...props
}: StandardDialogProps & { selecting: boolean }) {
  return (
    <StandardDialog
      {...props}
      className={
        selecting ? "max-h-[min(48rem,90dvh)] w-[calc(100%-2rem)]" : undefined
      }
      headerClassName="shrink-0"
      footerClassName="shrink-0"
      bodyClassName={
        selecting ? "flex flex-col overflow-hidden p-0" : undefined
      }
    />
  );
}

export function ImportSelectionList({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      {children}
    </section>
  );
}

export function ImportSettings({ children }: { children: ReactNode }) {
  return (
    <Collapsible className="shrink-0 border-t">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="m-2">
          <Settings2 />
          <span>Import settings</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="max-h-[min(12rem,25dvh)] space-y-5 overflow-y-auto px-4 pb-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
