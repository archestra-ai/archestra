"use client";

import { ChevronRight, Funnel } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useIsMobile } from "@/lib/hooks/use-mobile";

export function ExplorerToolbar({
  controls,
  chartType,
  actions,
  summary,
  model,
  onClearModel,
}: {
  controls: ReactNode;
  chartType: ReactNode;
  actions?: ReactNode;
  summary: string;
  model?: string;
  onClearModel: () => void;
}) {
  const isMobile = useIsMobile();
  const drilldown = model ? (
    <nav
      aria-label="Model drill-down"
      className="flex h-8 min-w-0 max-w-full items-center gap-1.5 text-sm"
    >
      <UnstyledButton
        aria-label="Clear model filter"
        onClick={onClearModel}
        className="shrink-0 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <span>All models</span>
      </UnstyledButton>
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <span className="truncate font-medium">{model}</span>
    </nav>
  ) : null;
  return (
    <div className="space-y-1 border-b bg-muted/30 px-3 py-2.5">
      {isMobile ? (
        <>
          {drilldown}
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {summary}
            </span>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Chart options"
                >
                  <Funnel aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                aria-label="Chart options"
                className="flex max-h-[var(--radix-popover-content-available-height)] w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto [&>button]:w-full [&>button]:justify-between"
              >
                <span className="text-sm font-medium">Chart options</span>
                {controls}
                <div className="space-y-1.5 border-t pt-3">
                  <span className="block text-xs font-medium text-muted-foreground">
                    Chart type
                  </span>
                  {chartType}
                </div>
                {actions}
              </PopoverContent>
            </Popover>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {controls}
          {drilldown}
          <div className="ml-auto">{chartType}</div>
          {actions}
        </div>
      )}
    </div>
  );
}
