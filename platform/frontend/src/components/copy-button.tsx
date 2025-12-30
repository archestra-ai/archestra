"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyButton({
  text,
  className,
  size = 14,
  behavior = "checkmark",
}: {
  text: string;
  className?: string;
  size?: number;
  behavior?: "checkmark" | "text";
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
          size="sm"
          className={`h-6 w-6 p-0 hover:bg-background/50 ${className ?? ""}`}
          title="Copy to Clipboard"
          onClick={handleCopy}
        >
          <Copy size={size} />
        </Button>
        {copied && <span className="ml-1 text-xs">Copied!</span>}
      </>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className={`h-6 w-6 p-0 hover:bg-background/50 ${className ?? ""}`}
      title="Copy to Clipboard"
      onClick={handleCopy}
    >
      {copied ? <Check size={size} /> : <Copy size={size} />}
    </Button>
  );
}
