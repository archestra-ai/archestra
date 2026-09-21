"use client";

import { Suggestion } from "@/components/ai-elements/suggestion";

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
}

export const SuggestedPromptPills = ({
  prompts,
  disabled,
  onSelect,
  onPreviewChange,
}: SuggestedPromptPillsProps) => (
  <div className="flex flex-wrap items-center justify-center gap-2 max-w-2xl">
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
