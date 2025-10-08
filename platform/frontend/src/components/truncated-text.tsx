import { AlignLeft } from "lucide-react";
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
}: {
  message: string | undefined;
  maxLength?: number;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [shouldShowIcon, setShouldShowIcon] = useState(false);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    if (open) {
      setShouldShowIcon(true);
    } else {
      // Delay hiding the icon until after the tooltip's exit animation
      setTimeout(() => setShouldShowIcon(false), 200);
    }
  };

  if (!message) {
    return <span className="text-muted-foreground">No message</span>;
  }

  const isTruncated = message.length > maxLength;
  const displayText = isTruncated
    ? `${message.slice(0, maxLength)}...`
    : message;

  return (
    <div className={cn(isTruncated ? "relative pr-8" : "", "overflow-hidden")}>
      <span>{displayText}</span>
      {isTruncated && (
        <Tooltip open={isOpen} onOpenChange={handleOpenChange}>
          <TooltipTrigger asChild>
            <AlignLeft
              className={`w-4 h-4 absolute top-1/2 right-2 -translate-y-1/2 ${shouldShowIcon ? "block" : "hidden group-hover:block"}`}
            />
          </TooltipTrigger>
          <TooltipContent className="max-w-md whitespace-pre-wrap break-words">
            {message}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
