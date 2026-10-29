"use client";

import { Response } from "@/components/ai-elements/response";
import { cn } from "@/lib/utils/tailwind";

/**
 * A question the agent asks, rendered as markdown rather than as plain text:
 * a link opens (through Response's link safety, so an external address asks
 * first), a backticked command reads as code, a fenced block keeps its copy
 * button, and the agent's line breaks stay where they were.
 *
 * The wrapper carries the `id`, so `aria-labelledby` can name the question.
 */
export function QuestionMarkdown({
  id,
  text,
  className,
}: {
  id?: string;
  text: string;
  className?: string;
}) {
  return (
    <div
      id={id}
      className={cn(
        "min-w-0 text-sm leading-6 text-foreground [overflow-wrap:anywhere]",
        className,
      )}
    >
      <Response preserveLineBreaks>{text}</Response>
    </div>
  );
}
