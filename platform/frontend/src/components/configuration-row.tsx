"use client";

import { CircleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function ConfigurationRow({
  id,
  value,
  title,
  summary,
  description,
  attention,
  children,
}: {
  id?: string;
  value: string;
  title: string;
  summary: string;
  description?: string;
  attention?: string;
  children: ReactNode;
}) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  return (
    <AccordionItem id={id} value={value} className="px-4 last:border-b-0">
      <AccordionTrigger
        className="min-w-0 items-center hover:no-underline"
        onFocus={() => setTooltipOpen(true)}
        onBlur={() => setTooltipOpen(false)}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-2 text-left sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <span className="min-w-0 space-y-1">
            <span className="flex items-center gap-2">
              <span>{title}</span>
              {attention && (
                <Tooltip open={tooltipOpen} onOpenChange={setTooltipOpen}>
                  <TooltipTrigger asChild>
                    <span
                      role="img"
                      aria-label={attention}
                      className="inline-flex shrink-0"
                    >
                      <CircleAlert
                        className="size-4 text-amber-600 dark:text-amber-400"
                        aria-hidden="true"
                      />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">{attention}</TooltipContent>
                </Tooltip>
              )}
            </span>
            {description && (
              <span className="block text-xs font-normal text-muted-foreground">
                {description}
              </span>
            )}
          </span>
          <span className="min-w-0 truncate text-sm font-normal text-muted-foreground sm:ml-auto sm:max-w-[45%] sm:text-right">
            {summary}
          </span>
        </span>
      </AccordionTrigger>
      <AccordionContent className="pt-2">{children}</AccordionContent>
    </AccordionItem>
  );
}
