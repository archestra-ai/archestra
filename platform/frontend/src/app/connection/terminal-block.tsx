"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SecretCopyButton } from "@/components/secret-copy-button";
import {
  TerminalCard,
  terminalActionClass,
  terminalCodeClass,
} from "@/components/terminal-surface";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils/tailwind";

interface TerminalBlockProps {
  /** Raw code to render and copy. Ignored when `rows` is provided. */
  code?: string;
  /**
   * Multiple code rows in one card, each with its own copy button and an
   * optional `#`-style comment line (e.g. Bedrock's two endpoints).
   */
  rows?: {
    comment?: string;
    code: string;
    /**
     * When set, the row's `code` is a placeholder rendering of something that
     * embeds a secret, and copying becomes an explicit choice between the real
     * value and the placeholder (see SecretCopyButton).
     */
    getSecretText?: () => Promise<string | null>;
  }[];
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
    <TerminalCard>
      {header}
      {effectiveRows.map((row, index) => (
        <div
          key={row.code}
          className={
            index > 0 ? "relative border-t border-terminal-edge" : "relative"
          }
        >
          {row.getSecretText ? (
            <div className="absolute right-2 top-2">
              <SecretCopyButton
                variant="terminal"
                getSecretText={row.getSecretText}
                placeholderText={row.code}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onCopy(row.code, index)}
              aria-label="Copy to clipboard"
              className={cn(
                terminalActionClass,
                "absolute right-2 top-2 size-7",
              )}
            >
              {copiedIndex === index ? (
                <Check
                  className="size-3.5 text-terminal-success"
                  strokeWidth={2.5}
                />
              ) : (
                <Copy className="size-3.5" strokeWidth={2} />
              )}
            </button>
          )}
          <pre
            className={cn(
              "m-0 max-h-[360px] overflow-auto px-5 py-4 pr-12",
              terminalCodeClass,
            )}
          >
            {row.comment && (
              <span className="select-none text-terminal-comment">
                # {row.comment}
                {"\n"}
              </span>
            )}
            {row.code}
          </pre>
        </div>
      ))}
    </TerminalCard>
  );
}
