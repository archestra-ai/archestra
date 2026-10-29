import { ComposerWarningIcon } from "@/components/chat/composer-warning-icon";

/**
 * Composer toolbar warning shown next to the model selector when the selected
 * model can't take tools while the selected agent has some: the turn runs
 * tool-less (the backend omits tools for such models), which the user should
 * learn before sending, not from tools silently never firing.
 */
export function NoToolsModelBadge() {
  return (
    <ComposerWarningIcon label="No tools">
      The selected model doesn&apos;t support tools, so this agent&apos;s tools
      won&apos;t be used in this chat. Switch models to use tools.
    </ComposerWarningIcon>
  );
}
