"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";

export function CopyButton({
  text,
  className,
  size = 14,
  behavior = "checkmark",
  buttonSize = "icon-xs",
  iconClassName,
  copiedIconClassName,
}: {
  text: string;
  className?: string;
  size?: number;
  behavior?: "checkmark" | "text";
  buttonSize?: "icon" | "icon-sm" | "icon-xs";
  iconClassName?: string;
  copiedIconClassName?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await copyToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const showCheckmark = behavior === "checkmark" && copied;
  const button = (
    <Button
      type="button"
      variant="ghost"
      size={buttonSize}
      className={`hover:bg-background/50 ${className ?? ""}`}
      onClick={handleCopy}
      disabled={behavior === "checkmark" ? copied : undefined}
    >
      {showCheckmark ? (
        <Check
          size={size}
          className={copiedIconClassName ?? "text-green-500"}
        />
      ) : (
        <Copy size={size} className={iconClassName} />
      )}
      <span className="sr-only">
        {showCheckmark ? "Copied!" : "Copy to clipboard"}
      </span>
    </Button>
  );

  if (behavior === "text") {
    return (
      <>
        {button}
        {copied && <span className="ml-1 text-xs">Copied!</span>}
      </>
    );
  }

  return button;
}
