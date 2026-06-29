"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

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
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (_error) {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      document.body.appendChild(textArea);
      textArea.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy:", err);
      }
      document.body.removeChild(textArea);
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
