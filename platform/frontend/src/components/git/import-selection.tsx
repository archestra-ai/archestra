"use client";

import { Settings2 } from "lucide-react";
import type { ReactNode } from "react";
import {
  StandardDialog,
  type StandardDialogProps,
} from "@/components/standard-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

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
      headerClassName="shrink-0 pr-10 text-left"
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
    <Accordion type="single" collapsible className="shrink-0 border-t">
      <AccordionItem value="settings">
        <AccordionTrigger className="items-center rounded-none px-4 py-3 hover:bg-muted/50 hover:no-underline">
          <span className="flex items-center gap-2">
            <Settings2 className="size-4" aria-hidden="true" />
            <span>Import settings</span>
          </span>
        </AccordionTrigger>
        <AccordionContent className="max-h-[min(12rem,25dvh)] space-y-5 overflow-y-auto px-4 pb-4">
          {children}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
