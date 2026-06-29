import type { ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface OverlappedIconsProps {
  /** Icons to render in the overlapped layout */
  icons: Array<{
    key: string;
    icon: ReactNode;
    tooltip?: string;
  }>;
  /** Maximum number of icons to show before overflow badge */
  maxVisible?: number;
  /** Size of each icon container in Tailwind units (default: 5 = 20px) */
  size?: "sm" | "md";
  /** Additional className for the container */
  className?: string;
  /** Tooltip text for overflow items (defaults to listing hidden tooltips) */
  overflowTooltip?: string;
}

export function OverlappedIcons({
  icons,
  maxVisible = 3,
  size = "md",
  className,
  overflowTooltip,
}: OverlappedIconsProps) {
  if (icons.length === 0) return null;

  const visible = icons.slice(0, maxVisible);
  const overflowCount = icons.length - maxVisible;

  const sizeClass = size === "sm" ? "size-4" : "size-5";
  const iconSize = size === "sm" ? "h-2.5 w-2.5" : "h-3 w-3";
  const overflowTextSize = size === "sm" ? "text-[8px]" : "text-[9px]";
  const spacing = size === "sm" ? "-space-x-1" : "-space-x-1.5";

  const hiddenTooltip =
    overflowTooltip ??
    icons
      .slice(maxVisible)
      .map((i) => i.tooltip)
      .filter(Boolean)
      .join(", ");

  return (
    <div className={cn("flex items-center", spacing, className)}>
      {visible.map((item) => {
        const iconEl = (
          <div
            key={item.key}
            className={cn(
              "flex shrink-0 items-center justify-center rounded-full bg-muted ring-1 ring-background overflow-hidden",
              sizeClass,
            )}
          >
            <div className={cn("flex items-center justify-center", iconSize)}>
              {item.icon}
            </div>
          </div>
        );

        if (item.tooltip) {
          return (
            <Tooltip key={item.key}>
              <TooltipTrigger asChild>{iconEl}</TooltipTrigger>
              <TooltipContent side="top">{item.tooltip}</TooltipContent>
            </Tooltip>
          );
        }

        return iconEl;
      })}
      {overflowCount > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "flex shrink-0 items-center justify-center rounded-full bg-muted ring-1 ring-background font-medium text-muted-foreground",
                  sizeClass,
                  overflowTextSize,
                )}
              >
                +{overflowCount}
              </div>
            </TooltipTrigger>
            {hiddenTooltip && (
              <TooltipContent side="top">{hiddenTooltip}</TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}
