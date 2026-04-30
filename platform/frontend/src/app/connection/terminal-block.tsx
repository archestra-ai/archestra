"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface TerminalBlockProps {
  /** Raw code to render and copy. */
  code: string;
}

export function TerminalBlock({ code }: TerminalBlockProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="relative overflow-hidden rounded-xl border border-[#1f2937] bg-[#0d1117] shadow-lg">
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy to clipboard"
        className="absolute right-2 top-2 flex size-7 items-center justify-center rounded border border-[#1f2937] bg-[#0d1117] text-[#9ca3af] transition-colors hover:text-white"
      >
        {copied ? (
          <Check className="size-3.5 text-[#4ade80]" strokeWidth={2.5} />
        ) : (
          <Copy className="size-3.5" strokeWidth={2} />
        )}
      </button>
      <pre className="m-0 max-h-[360px] overflow-auto px-5 py-4 pr-12 font-mono text-[13px] leading-[1.65] text-[#e5e7eb]">
        {code}
      </pre>
    </div>
  );
}
