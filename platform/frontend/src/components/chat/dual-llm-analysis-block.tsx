"use client";

import type { DualLlmAnalysisPartData } from "@archestra/shared";
import {
  ChevronDownIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/**
 * The dual LLM guardrail's analysis of one tool result, rendered as its own
 * collapsed block so the sanitization workflow never reads as (or fuses with)
 * the assistant's answer. Expands to the interrogation rounds and the
 * sanitized summary that replaced the raw result; a failed analysis renders
 * open, since it explains why the turn stopped.
 */
export function DualLlmAnalysisBlock({
  data,
}: {
  data: DualLlmAnalysisPartData;
}) {
  const failed = data.status === "failed";
  const [isOpen, setIsOpen] = useState(failed);

  const questionCount = data.rounds.length || data.questionCount || 0;
  const questions = `${questionCount} ${questionCount === 1 ? "question" : "questions"}`;
  const statusLabel = failed
    ? "failed"
    : data.status === "analyzing"
      ? questionCount > 0
        ? `analyzing — ${questions} so far`
        : "analyzing…"
      : data.cached
        ? `${questions} (cached)`
        : questions;

  return (
    // Shares the Thinking row's shape (`not-prose mb-4 pl-2`, borderless
    // trigger that hugs its label): both are inline turn annotations, so a
    // full-width card here would read as a heavier object than the thinking
    // blocks it sits between.
    <Collapsible
      className="not-prose mb-4 pl-2"
      open={isOpen}
      onOpenChange={setIsOpen}
    >
      <CollapsibleTrigger
        className={cn(
          "flex items-center gap-2 text-left text-sm transition-colors hover:text-foreground",
          failed ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {failed ? (
          <ShieldAlertIcon className="size-4 shrink-0" />
        ) : (
          <ShieldCheckIcon className="size-4 shrink-0" />
        )}
        <span>
          Dual LLM analysis · <span className="font-mono">{data.toolName}</span>{" "}
          · {statusLabel}
        </span>
        <ChevronDownIcon
          className={cn(
            "size-4 shrink-0 transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-4 space-y-3 text-sm text-muted-foreground">
        {data.rounds.map((round, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rounds are append-only within one analysis
            key={`${data.toolCallId}-round-${index}`}
            className="space-y-1"
          >
            <p className="font-medium">{round.question}</p>
            <ol className="list-inside space-y-0.5 text-muted-foreground">
              {round.options.map((option, optionIndex) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: options are positional by design (the answer is an index)
                  key={optionIndex}
                  className={cn(
                    String(optionIndex) === round.answer &&
                      "font-medium text-foreground",
                  )}
                >
                  {optionIndex}: {option}
                </li>
              ))}
            </ol>
            {!round.options.some(
              (_, optionIndex) => String(optionIndex) === round.answer,
            ) && (
              <p className="text-muted-foreground">Answer: {round.answer}</p>
            )}
          </div>
        ))}
        {data.rounds.length === 0 && data.cached && (
          <p className="text-muted-foreground">
            Reused a previous analysis of this result.
          </p>
        )}
        {data.summary && (
          <div className="space-y-1">
            <p className="font-medium">Sanitized summary</p>
            <p className="whitespace-pre-wrap text-muted-foreground">
              {data.summary}
            </p>
          </div>
        )}
        {data.failureMessage && (
          <p className="whitespace-pre-wrap text-destructive">
            {data.failureMessage}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
