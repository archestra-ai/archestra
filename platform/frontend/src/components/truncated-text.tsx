import { useState } from "react";
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
}: {
  message: string | undefined;
  maxLength?: number;
  className?: string;
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
        className,
      )}
    >
      {!isTruncated && <span>{displayText}</span>}
      {isTruncated && (
        <Tooltip open={isOpen} onOpenChange={handleOpenChange}>
          <TooltipTrigger asChild>
            <span>{displayText}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-md whitespace-pre-wrap break-words">
            {message}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
