"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import { pickChatGreeting } from "./chat-landing-greeting";
import type { SuggestedPrompt } from "./suggested-prompt-pills";

export type ChatLandingStyle =
  archestraApiTypes.GetOrganizationResponses["200"]["chatLandingStyle"];

interface ChatLandingProps {
  /** `classic` is rendered by the chat page itself. */
  layout: Exclude<ChatLandingStyle, "classic">;
  animateHeadline: boolean;
  userName?: string | null;
  composer: ReactNode;
  prompts: SuggestedPrompt[];
  promptsDisabled?: boolean;
  onSelectPrompt: (prompt: SuggestedPrompt) => void;
  /** Shows a suggestion's full prompt in the empty composer while hovered. */
  onPreviewChange: (prompt: string | null) => void;
  footer?: ReactNode;
}

/**
 * The greeting-led new-chat layouts: a time-of-day greeting over the composer,
 * with suggestions as quiet text (`greeting`) or three tiles plus links
 * (`glance`).
 */
export function ChatLanding({
  layout,
  animateHeadline,
  userName,
  composer,
  prompts,
  promptsDisabled,
  onSelectPrompt,
  onPreviewChange,
  footer,
}: ChatLandingProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const live = layout === "greeting" && animateHeadline && prompts.length > 0;
  const cycled = useCycle(prompts.length, 2800, !live || hovered !== null);
  const active = live ? (hovered ?? cycled) : null;

  const promptHandlers = (prompt: SuggestedPrompt, index: number) => ({
    disabled: promptsDisabled,
    onMouseEnter: () => {
      setHovered(index);
      onPreviewChange(prompt.prompt);
    },
    onMouseLeave: () => {
      setHovered(null);
      onPreviewChange(null);
    },
    onFocus: () => {
      setHovered(index);
      onPreviewChange(prompt.prompt);
    },
    onBlur: () => {
      setHovered(null);
      onPreviewChange(null);
    },
    onClick: () => {
      onPreviewChange(null);
      onSelectPrompt(prompt);
    },
  });

  const phrase =
    active !== null ? prompts[active]?.summaryTitle.toLowerCase() : undefined;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
      <div className="flex-1 flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-3xl">
          <div className="text-4xl md:text-5xl font-semibold tracking-tighter leading-[1.1]">
            <h1
              suppressHydrationWarning
              className="animate-in fade-in slide-in-from-bottom-2 duration-700 text-foreground"
            >
              {pickChatGreeting({ date: new Date(), name: userName })}
            </h1>
            <p className="animate-in fade-in slide-in-from-bottom-2 duration-700 pb-1 text-muted-foreground/60">
              {phrase ? (
                <span>
                  Let's{" "}
                  <span
                    key={phrase}
                    className="inline-block animate-in fade-in slide-in-from-bottom-2 duration-500 text-foreground/80"
                  >
                    {phrase}.
                  </span>
                </span>
              ) : (
                <span>What's on your mind?</span>
              )}
            </p>
          </div>
          <div className="mt-8">{composer}</div>
          {layout === "greeting" && prompts.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1 animate-in fade-in duration-700">
              {prompts.map((prompt, index) => (
                <UnstyledButton
                  key={`${prompt.summaryTitle}-${prompt.prompt}`}
                  {...promptHandlers(prompt, index)}
                  className={cn(
                    "rounded-md px-2 py-1 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50",
                    index === active
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {prompt.summaryTitle}
                </UnstyledButton>
              ))}
            </div>
          )}
          {layout === "glance" && prompts.length > 0 && (
            <GlancePrompts prompts={prompts} handlers={promptHandlers} />
          )}
        </div>
      </div>
      {footer && <div className="p-4 text-center">{footer}</div>}
    </div>
  );
}

// ===

function GlancePrompts({
  prompts,
  handlers,
}: {
  prompts: SuggestedPrompt[];
  handlers: (
    prompt: SuggestedPrompt,
    index: number,
  ) => ComponentProps<typeof UnstyledButton>;
}) {
  const featured = prompts.slice(0, 3);
  const rest = prompts.slice(3);
  return (
    <div className="animate-in fade-in duration-700">
      <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {featured.map((prompt, index) => (
          <UnstyledButton
            key={`${prompt.summaryTitle}-${prompt.prompt}`}
            {...handlers(prompt, index)}
            className="min-w-0 rounded-lg bg-foreground/[0.03] px-3.5 py-3 text-left outline-none transition-colors hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            <span className="block text-sm font-medium text-foreground">
              {prompt.summaryTitle}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {prompt.prompt}
            </span>
          </UnstyledButton>
        ))}
      </div>
      {rest.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
          {rest.map((prompt, index) => (
            <UnstyledButton
              key={`${prompt.summaryTitle}-${prompt.prompt}`}
              {...handlers(prompt, index + featured.length)}
              className="rounded outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
            >
              {prompt.summaryTitle}
            </UnstyledButton>
          ))}
        </div>
      )}
    </div>
  );
}

/** Index advancing every `ms`; holds still while paused or under reduced motion. */
function useCycle(length: number, ms: number, paused: boolean) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (paused || length < 2) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = setInterval(() => setIndex((n) => (n + 1) % length), ms);
    return () => clearInterval(timer);
  }, [length, ms, paused]);
  return index % Math.max(length, 1);
}
