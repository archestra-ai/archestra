"use client";

import { useState } from "react";
import { Button } from "./ui/button";

export default function CopyButton({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("Copy failed", e);
    }
  }

  return (
    <Button
      type="button"
      onClick={onCopy}
      className={`transition ${className}`}
      aria-label="Copy to clipboard"
      variant="ghost"
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
