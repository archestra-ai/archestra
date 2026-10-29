import { ComposerWarningIcon } from "@/components/chat/composer-warning-icon";

/**
 * Composer toolbar warning shown next to the model selector when the sync
 * judged the selected model a poor fit for agent work while the selected agent
 * brings tools. Unlike the no-tools warning the turn is not guaranteed to
 * degrade (the model may well carry the loop), so the copy advises rather than
 * states.
 */
export function NotRecommendedForAgentsNoticeBadge() {
  return (
    <ComposerWarningIcon label="Limited for complex tasks">
      This model works best for simple questions and chat. For complex work,
      switch to a more capable model.
    </ComposerWarningIcon>
  );
}
