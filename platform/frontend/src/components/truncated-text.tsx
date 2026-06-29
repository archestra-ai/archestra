import { type ComponentProps, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function TruncatedText({
  message,
  maxLength = 50,
  className,
  tooltipContentProps,
  tooltipProps,
  showTooltip = true,
  noWrap = true,
}: {
  message: string | undefined;
  maxLength?: number;
  className?: string;
  tooltipProps?: ComponentProps<typeof Tooltip>;
  tooltipContentProps?: ComponentProps<typeof TooltipContent>;
  showTooltip?: boolean;
  /** Prevent text from wrapping. Defaults to true. */
  noWrap?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
  };

  if (!message) {
    return <span className="text-muted-foreground">No message</span>;
  }

  const isTruncated = message.length > maxLength;
  const displayText = isTruncated
    ? `${message.slice(0, maxLength)}...`
    : message;

  return (
    <div
      className={cn(
        isTruncated ? "relative pr-8" : "",
        "overflow-hidden group",
        noWrap && "whitespace-nowrap",
        className,
      )}
    >
      {(!isTruncated || !showTooltip) && <span>{displayText}</span>}
      {isTruncated && showTooltip && (
        <Tooltip
          open={isOpen}
          onOpenChange={handleOpenChange}
          {...tooltipProps}
        >
          <TooltipTrigger asChild>
            <span>{displayText}</span>
          </TooltipTrigger>
          <TooltipContent
            {...tooltipContentProps}
            className={cn("max-w-sm", tooltipContentProps?.className)}
          >
            {message}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
