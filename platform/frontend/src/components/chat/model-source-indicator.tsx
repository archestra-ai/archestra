import {
  BotIcon,
  Building2Icon,
  PencilLineIcon,
  RotateCcwIcon,
  UserRoundIcon,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { ModelSource } from "@/lib/chat/use-chat-preferences";

/**
 * Quiet glyph at the end of the composer's model controls saying where the
 * selected model came from: the agent, the organization default, or the
 * user. The words live in the tooltip, so the toolbar stays uncluttered while
 * the meaning is one hover (or focus) away. A model the user picked doubles
 * as the reset control, swapping to a reset glyph on hover.
 */
export function ModelSourceIndicator({
  source,
  inConversation,
  onReset,
}: {
  source: ModelSource;
  /** Inside an existing conversation the user's pick applies to that chat only. */
  inConversation: boolean;
  onReset?: () => void;
}) {
  const Icon =
    source === "agent"
      ? BotIcon
      : source === "organization"
        ? Building2Icon
        : inConversation
          ? PencilLineIcon
          : UserRoundIcon;
  const explanation =
    source === "agent"
      ? "Using the model configured on this agent."
      : source === "organization"
        ? "Using your organization's default model. This agent doesn't set its own."
        : inConversation
          ? "You changed the model for this chat only."
          : "Using the model you last picked instead of the default.";
  const resettable = source === "user" && onReset;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {resettable ? (
          <UnstyledButton
            type="button"
            aria-label="Reset to the default model"
            onClick={onReset}
            className="group/model-source mr-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:text-foreground"
          >
            <Icon className="size-3.5 group-hover/model-source:hidden group-focus-visible/model-source:hidden" />
            <RotateCcwIcon className="hidden size-3.5 group-hover/model-source:block group-focus-visible/model-source:block" />
          </UnstyledButton>
        ) : (
          <span
            role="img"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users can reach the tooltip that explains the glyph
            tabIndex={0}
            aria-label={explanation}
            className="mr-1.5 inline-flex size-6 shrink-0 cursor-default items-center justify-center rounded text-muted-foreground/60 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon className="size-3.5" />
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-60">
        {explanation}
        {resettable && (
          <span className="block text-muted-foreground">
            Click to reset to the default model.
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
