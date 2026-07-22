"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { copyToClipboard } from "@/lib/clipboard";

interface TerminalBlockProps {
  /** Raw code to render and copy. Ignored when `rows` is provided. */
  code?: string;
  /**
   * Multiple code rows in one card, each with its own copy button and an
   * optional `#`-style comment line (e.g. Bedrock's two endpoints).
   */
  rows?: { comment?: string; code: string }[];
  /**
   * Optional row rendered inside the card above the code — e.g. the provider
   * toggler tabs used by the setup-script and proxy-endpoint cards.
   */
  header?: React.ReactNode;
}

export function TerminalBlock({ code, rows, header }: TerminalBlockProps) {
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const effectiveRows = rows ?? (code !== undefined ? [{ code }] : []);

  const onCopy = async (rowCode: string, index: number) => {
    await copyToClipboard(rowCode);
    setCopiedIndex(index);
    toast.success("Copied to clipboard");
    setTimeout(() => setCopiedIndex(null), 1600);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-[#1f2937] bg-[#0d1117] shadow-lg">
      {header}
      {effectiveRows.map((row, index) => (
        <div
          key={row.code}
          className={
            index > 0 ? "relative border-t border-[#1f2937]" : "relative"
          }
        >
          <button
            type="button"
            onClick={() => onCopy(row.code, index)}
            aria-label="Copy to clipboard"
            className="absolute right-2 top-2 flex size-7 items-center justify-center rounded border border-[#1f2937] bg-[#0d1117] text-[#9ca3af] transition-colors hover:text-white"
          >
            {copiedIndex === index ? (
              <Check className="size-3.5 text-[#4ade80]" strokeWidth={2.5} />
            ) : (
              <Copy className="size-3.5" strokeWidth={2} />
            )}
          </button>
          <pre className="m-0 max-h-[360px] overflow-auto px-5 py-4 pr-12 font-mono text-[13px] leading-[1.65] text-[#e5e7eb]">
            {row.comment && (
              <span className="select-none text-[#6d7681]">
                # {row.comment}
                {"\n"}
              </span>
            )}
            {row.code}
          </pre>
        </div>
      ))}
    </div>
  );
}
