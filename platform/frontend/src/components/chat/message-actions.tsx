import { Check, Copy, Pencil, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function MessageActions({
  textToCopy,
  onEditClick,
  onRegenerateClick,
  isRegenerateConfirming,
  className,
  editDisabled = false,
}: {
  className?: string;
  textToCopy: string;
  onEditClick?: () => void;
  onRegenerateClick?: () => void;
  isRegenerateConfirming?: boolean;
  editDisabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      data-message-actions
      className={cn(
        "flex items-center gap-0.5 px-4 py-0",
        className,
        isTooltipOpen && "opacity-100 pointer-events-auto",
      )}
    >
      {isRegenerateConfirming ? (
        <>
          <span className="text-xs text-muted-foreground whitespace-nowrap px-1.5">
            All messages below will be regenerated
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-amber-500 hover:text-amber-600 hover:bg-muted"
            onClick={onRegenerateClick}
          >
            Confirm
          </Button>
        </>
      ) : (
        <>
          <Tooltip onOpenChange={setIsTooltipOpen}>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 hover:bg-muted"
                onClick={handleCopy}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <span className="sr-only">{copied ? "Copied" : "Copy"}</span>
              </Button>
            </TooltipTrigger>
            <MessageActionTooltipContent>
              {copied ? "Copied" : "Copy"}
            </MessageActionTooltipContent>
          </Tooltip>
          {onEditClick && (
            <Tooltip onOpenChange={setIsTooltipOpen}>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 hover:bg-muted"
                  onClick={onEditClick}
                  disabled={editDisabled}
                >
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="sr-only">Edit</span>
                </Button>
              </TooltipTrigger>
              <MessageActionTooltipContent>Edit</MessageActionTooltipContent>
            </Tooltip>
          )}
          {onRegenerateClick && (
            <Tooltip onOpenChange={setIsTooltipOpen}>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 hover:bg-muted"
                  onClick={onRegenerateClick}
                  disabled={editDisabled}
                >
                  <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="sr-only">Regenerate</span>
                </Button>
              </TooltipTrigger>
              <MessageActionTooltipContent>
                Regenerate
              </MessageActionTooltipContent>
            </Tooltip>
          )}
        </>
      )}
    </div>
  );
}

function MessageActionTooltipContent({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <TooltipContent
      side="bottom"
      sideOffset={4}
      noArrow
      className="animate-none data-[state=closed]:animate-none pointer-events-none"
    >
      {children}
    </TooltipContent>
  );
}
