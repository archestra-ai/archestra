import { AlertTriangle, Check, Copy, Pencil, Sparkles } from "lucide-react";
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
  onEditClick: () => void;
  onRegenerateClick?: () => void;
  isRegenerateConfirming?: boolean;
  editDisabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        "flex items-center gap-0.5 rounded-md border bg-background/95 shadow-sm p-0.5",
        className,
      )}
    >
      {isRegenerateConfirming ? (
        <>
          <div className="flex items-center gap-1 px-1.5">
            <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              Click again to regenerate the response and remove all subsequent
              messages
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 hover:bg-muted"
                onClick={onRegenerateClick}
              >
                <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                <span className="sr-only">Confirm regenerate</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Confirm regenerate</TooltipContent>
          </Tooltip>
        </>
      ) : (
        <>
          <Tooltip>
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
            <TooltipContent side="bottom">
              {copied ? "Copied" : "Copy"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
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
            <TooltipContent side="bottom">Edit</TooltipContent>
          </Tooltip>
          {onRegenerateClick && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 hover:bg-muted"
                  onClick={onRegenerateClick}
                  disabled={editDisabled}
                >
                  <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="sr-only">Regenerate</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Regenerate</TooltipContent>
            </Tooltip>
          )}
        </>
      )}
    </div>
  );
}
