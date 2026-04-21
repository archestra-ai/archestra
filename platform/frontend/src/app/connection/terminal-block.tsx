"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

interface TerminalBlockProps {
  /** Filename or label shown next to the traffic-light dots. */
  title: string;
  /** Short language label shown as a pill next to the title. */
  language: string;
  /** Raw code to render and copy. */
  code: string;
}

/**
 * Dark GitHub-style terminal block.
 *
 * Matches the code block in the handoff mockup (`instructions.jsx`):
 *  - `#0d1117` canvas, `#111827` title bar, `#1f2937` border
 *  - three macOS traffic-light dots
 *  - filename + language pill on the left
 *  - copy button on the right
 */
export function TerminalBlock({ title, language, code }: TerminalBlockProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-[#1f2937] bg-[#0d1117] shadow-lg">
      <div className="flex items-center gap-2.5 border-b border-[#1f2937] bg-[#111827] px-3.5 py-2.5">
        <span className="size-2.5 rounded-full bg-[#ef4444]" />
        <span className="size-2.5 rounded-full bg-[#f59e0b]" />
        <span className="size-2.5 rounded-full bg-[#22c55e]" />
        <span className="ml-2 truncate font-mono text-xs text-[#9ca3af]">
          {title}
        </span>
        <span className="ml-1 rounded bg-[#1f2937] px-1.5 py-0.5 font-mono text-[10px] uppercase text-[#9ca3af]">
          {language}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy to clipboard"
          className="ml-auto flex size-7 items-center justify-center rounded border border-[#1f2937] bg-[#0d1117] text-[#9ca3af] transition-colors hover:text-white"
        >
          {copied ? (
            <Check className="size-3.5 text-[#4ade80]" strokeWidth={2.5} />
          ) : (
            <Copy className="size-3.5" strokeWidth={2} />
          )}
        </button>
      </div>
      <pre className="m-0 max-h-[360px] overflow-auto px-5 py-4 font-mono text-[13px] leading-[1.65] text-[#e5e7eb]">
        {code}
      </pre>
    </div>
  );
}
