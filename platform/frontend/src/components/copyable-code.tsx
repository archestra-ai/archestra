"use client";

import { Check, Copy } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CopyableCodeProps {
  /** The text to copy to clipboard */
  value: string;
  /** Toast message shown on copy (default: "Copied to clipboard") */
  toastMessage?: string;
  /** Visual variant: "muted" (gray bg) or "primary" (accent bg + border) */
  variant?: "muted" | "primary";
  /** Additional classes for the container */
  className?: string;
  /** Custom display content. If omitted, displays `value` as monospace text. */
  children?: ReactNode;
}

export function CopyableCode({
  value,
  toastMessage = "Copied to clipboard",
  variant = "muted",
  className,
  children,
}: CopyableCodeProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success(toastMessage);
    setTimeout(() => setCopied(false), 2000);
  }, [value, toastMessage]);

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2",
        variant === "muted" && "bg-muted",
        variant === "primary" && "bg-primary/5 border border-primary/20",
        className,
      )}
    >
      <div className="flex-1 min-w-0">
        {children ?? (
          <code
            className={cn(
              "text-xs break-all",
              variant === "primary" && "text-primary",
            )}
          >
            {value}
          </code>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0"
        onClick={handleCopy}
      >
        {copied ? (
          <Check className="h-3 w-3 text-green-500" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </Button>
    </div>
  );
}
