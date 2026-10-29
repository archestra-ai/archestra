"use client";

import { toast } from "sonner";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";

interface JsonCodeBlockProps {
  value: unknown;
  maxHeightClassName?: string;
  /**
   * "pane": tighter padding and no copy button of its own, for a pane whose
   * header row already carries the copy action.
   */
  variant?: "default" | "pane";
}

export function JsonCodeBlock({
  value,
  maxHeightClassName = "max-h-[600px] overflow-auto",
  variant = "default",
}: JsonCodeBlockProps) {
  const formattedJson = JSON.stringify(value, null, 2);
  const pane = variant === "pane";

  return (
    <div className={pane ? undefined : "mt-2"}>
      <CodeBlock
        className="rounded-lg"
        code={formattedJson}
        language="json"
        wrapLongLines
        contentClassName={`${maxHeightClassName} overflow-x-hidden`}
        contentStyle={
          pane
            ? {
                fontSize: "0.75rem",
                lineHeight: "1.25rem",
                padding: "0.5rem 0.75rem",
              }
            : { fontSize: "0.75rem", paddingRight: "3.5rem" }
        }
      >
        {pane ? null : (
          <CodeBlockCopyButton
            title="Copy JSON"
            onCopy={() => toast.success("JSON copied")}
            onError={() => toast.error("Failed to copy JSON")}
          />
        )}
      </CodeBlock>
    </div>
  );
}
