"use client";

import { Suggestion } from "@/components/ai-elements/suggestion";
import { cn } from "@/lib/utils";

export interface SuggestedPrompt {
  summaryTitle: string;
  prompt: string;
}

export function resolveSuggestionPreview(
  prompts: SuggestedPrompt[] | undefined,
  hoveredPrompt: string | null,
): string | null {
  const stillOffered = prompts?.some(({ prompt }) => prompt === hoveredPrompt);
  return stillOffered ? hoveredPrompt : null;
}

interface SuggestedPromptPillsProps {
  prompts: SuggestedPrompt[];
  disabled?: boolean;
  onSelect: (prompt: SuggestedPrompt) => void;
  onPreviewChange: (prompt: string | null) => void;
  align?: "start" | "center";
}

export const SuggestedPromptPills = ({
  prompts,
  disabled,
  onSelect,
  onPreviewChange,
  align = "center",
}: SuggestedPromptPillsProps) => (
  <div
    className={cn(
      "flex flex-wrap items-center gap-2 max-w-2xl",
      align === "start" ? "justify-start" : "justify-center",
    )}
  >
    {prompts.map((suggestedPrompt) => (
      <Suggestion
        key={`${suggestedPrompt.summaryTitle}-${suggestedPrompt.prompt}`}
        suggestion={suggestedPrompt.summaryTitle}
        disabled={disabled}
        onMouseEnter={() => onPreviewChange(suggestedPrompt.prompt)}
        onMouseLeave={() => onPreviewChange(null)}
        onClick={() => {
          onPreviewChange(null);
          onSelect(suggestedPrompt);
        }}
      />
    ))}
  </div>
);
