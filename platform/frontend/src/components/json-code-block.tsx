"use client";

import { toast } from "sonner";
import {
  CodeBlock,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";

interface JsonCodeBlockProps {
  value: unknown;
  maxHeightClassName?: string;
}

export function JsonCodeBlock({
  value,
  maxHeightClassName = "max-h-[600px]",
}: JsonCodeBlockProps) {
  const formattedJson = JSON.stringify(value, null, 2);

  return (
    <div className={`mt-2 overflow-hidden rounded-lg ${maxHeightClassName}`}>
      <CodeBlock
        className="rounded-lg"
        code={formattedJson}
        language="json"
        contentStyle={{
          fontSize: "0.75rem",
          paddingRight: "3.5rem",
        }}
      >
        <CodeBlockCopyButton
          title="Copy JSON"
          onCopy={() => toast.success("JSON copied")}
          onError={() => toast.error("Failed to copy JSON")}
        />
      </CodeBlock>
    </div>
  );
}
