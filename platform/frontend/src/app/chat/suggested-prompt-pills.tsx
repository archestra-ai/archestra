"use client";

import { useEffect, useRef } from "react";
import { Suggestion } from "@/components/ai-elements/suggestion";

export interface SuggestedPrompt {
  summaryTitle: string;
  prompt: string;
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
}: SuggestedPromptPillsProps) => {
  const onPreviewChangeRef = useRef(onPreviewChange);
  useEffect(() => {
    onPreviewChangeRef.current = onPreviewChange;
  });

  // Pills taken away from under the pointer never send their mouse leave.
  useEffect(() => () => onPreviewChangeRef.current(null), []);

  return (
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
};
