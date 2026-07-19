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
  buttonSize = "sm",
  iconClassName,
  copiedIconClassName,
}: {
  text: string;
  className?: string;
  size?: number;
  behavior?: "checkmark" | "text";
  buttonSize?: "default" | "sm" | "lg" | "icon";
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

  if (behavior === "text") {
    return (
      <>
        <Button
          variant="ghost"
          size={buttonSize}
          className={`h-6 w-6 p-0 hover:bg-background/50 ${className ?? ""}`}
          onClick={handleCopy}
        >
          <Copy size={size} className={iconClassName} />
          <span className="sr-only">Copy to clipboard</span>
        </Button>
        {copied && <span className="ml-1 text-xs">Copied!</span>}
      </>
    );
  }

  return (
    <Button
      variant="ghost"
      size={buttonSize}
      className={`h-6 w-6 p-0 hover:bg-background/50 ${className ?? ""}`}
      onClick={handleCopy}
      disabled={copied}
    >
      {copied ? (
        <Check
          size={size}
          className={copiedIconClassName ?? "text-green-500"}
        />
      ) : (
        <Copy size={size} className={iconClassName} />
      )}
      <span className="sr-only">
        {copied ? "Copied!" : "Copy to clipboard"}
      </span>
    </Button>
  );
}
