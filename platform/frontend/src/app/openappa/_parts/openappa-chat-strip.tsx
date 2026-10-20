"use client";

import { BUILT_IN_AGENT_NAMES } from "@archestra/shared";
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  FileText,
  type LucideIcon,
  PencilLine,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppaKeeperIcon } from "@/components/appa-keeper-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/ui/permission-button";
import { OPENAPPA_SUGGESTED_LAUNCH_PROMPTS } from "@/lib/openappa-chat-prompts";
import { cn } from "@/lib/utils/tailwind";
import {
  OpenAppaChatButton,
  useOpenAppaChatLaunch,
} from "./openappa-chat-button";

type SuggestedPromptKey = keyof typeof OPENAPPA_SUGGESTED_LAUNCH_PROMPTS;

/** The agent's suggested prompts, as the chat shows them: title as the label. */
const QUESTIONS = Object.entries(OPENAPPA_SUGGESTED_LAUNCH_PROMPTS).map(
  ([promptKey, suggested]) => ({
    promptKey: promptKey as SuggestedPromptKey,
    label: suggested.summaryTitle,
  }),
);

const AGENT_NAME = BUILT_IN_AGENT_NAMES.OPENAPPA_CONFIG;
const CHAT_LABEL = `Chat with ${AGENT_NAME}`;

/**
 * Ways into the configuration agent: a plain chat that opens on the agent's
 * suggested prompts, then those same prompts, each sending itself. From `sm`
 * up the prompts sit on one row that scrolls sideways when it does not fit,
 * so the card keeps one height; phones fold them into an "Ask" menu beside
 * the chat button instead.
 */
export function OpenAppaChatStrip() {
  const { trackRef, canScrollStart, canScrollEnd, scrollByPage } =
    useHorizontalScroll();

  return (
    <Card className="gap-3 px-4 py-3 sm:py-4">
      <div className="hidden flex-wrap items-center gap-x-3 gap-y-3 sm:flex">
        <div className="flex min-w-[12rem] flex-1 items-center gap-3">
          <div
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 [&>svg]:size-5"
          >
            <AppaKeeperIcon />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{`Ask ${AGENT_NAME}`}</h2>
            <p className="text-sm text-muted-foreground">
              Get help reading, testing, or changing your policy.
            </p>
          </div>
        </div>
        <OpenAppaChatButton size="sm" variant="outline">
          <span>Open chat</span>
          <ArrowRight />
        </OpenAppaChatButton>
      </div>
      <div className="relative -mx-4 hidden sm:block">
        <ul
          ref={trackRef}
          aria-label={`Suggested questions for ${AGENT_NAME}`}
          className={cn(
            "flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto px-4 pb-0.5",
            "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          )}
        >
          {QUESTIONS.map((question) => (
            <li key={question.promptKey} className="shrink-0 snap-start">
              <OpenAppaChatButton
                size="sm"
                variant="outline"
                className="rounded-full bg-transparent font-normal text-muted-foreground hover:text-foreground dark:bg-transparent"
                promptKey={question.promptKey}
              >
                <span>{question.label}</span>
              </OpenAppaChatButton>
            </li>
          ))}
        </ul>
        <ScrollEdge
          side="start"
          visible={canScrollStart}
          onClick={() => scrollByPage(-1)}
        />
        <ScrollEdge
          side="end"
          visible={canScrollEnd}
          onClick={() => scrollByPage(1)}
        />
      </div>
      <div className="flex gap-2 sm:hidden">
        <OpenAppaChatButton size="sm" className="min-w-0 flex-1">
          <AppaKeeperIcon />
          <span className="truncate">{CHAT_LABEL}</span>
        </OpenAppaChatButton>
        <SuggestedPromptsMenu />
      </div>
    </Card>
  );
}

// ===

const PROMPT_ICONS: Record<SuggestedPromptKey, LucideIcon> = {
  explainGuardrails: BookOpen,
  explainPolicy: FileText,
  reviewRisks: ShieldAlert,
  changePolicy: PencilLine,
  validatePolicy: CircleCheck,
};

function SuggestedPromptsMenu() {
  // Every suggested prompt opens the same agent under the same permissions,
  // so the plain chat's launch state gates the whole menu.
  const { href, permissions } = useOpenAppaChatLaunch({
    subject: { kind: "suggestedPrompts" },
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <PermissionButton
          size="sm"
          variant="outline"
          permissions={permissions}
          disabled={!href}
        >
          <span>Ask</span>
          <ChevronDown />
        </PermissionButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {QUESTIONS.map((question) => (
          <SuggestedPromptItem
            key={question.promptKey}
            promptKey={question.promptKey}
            label={question.label}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SuggestedPromptItem({
  promptKey,
  label,
}: {
  promptKey: SuggestedPromptKey;
  label: string;
}) {
  const { href } = useOpenAppaChatLaunch({
    subject: { kind: "prompt", promptKey },
  });
  const Icon = PROMPT_ICONS[promptKey];
  if (!href) {
    return (
      <DropdownMenuItem disabled>
        <Icon />
        <span>{label}</span>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem asChild>
      <Link href={href}>
        <Icon />
        <span>{label}</span>
      </Link>
    </DropdownMenuItem>
  );
}

/**
 * A fade over the row's clipped edge, with an arrow for pointers that cannot
 * scroll sideways. Hidden from assistive tech: the list itself scrolls, and
 * every prompt is reachable with Tab.
 */
function ScrollEdge({
  side,
  visible,
  onClick,
}: {
  side: "start" | "end";
  visible: boolean;
  onClick: () => void;
}) {
  const Icon = side === "start" ? ChevronLeft : ChevronRight;
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-y-0 flex w-16 items-center transition-opacity",
        side === "start"
          ? "left-0 justify-start bg-gradient-to-r pl-2"
          : "right-0 justify-end bg-gradient-to-l pr-2",
        "from-card via-card/90 to-transparent",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <Button
        type="button"
        size="icon"
        variant="outline"
        tabIndex={-1}
        aria-label={
          side === "start" ? "Scroll suggestions back" : "Scroll suggestions on"
        }
        onClick={onClick}
        className={cn(
          "size-7 rounded-full shadow-sm",
          visible && "pointer-events-auto",
        )}
      >
        <Icon />
      </Button>
    </div>
  );
}

function useHorizontalScroll() {
  const trackRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const max = track.scrollWidth - track.clientWidth;
    setEdges({ start: track.scrollLeft > 1, end: track.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    measure();
    track.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => {
      track.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [measure]);

  const scrollByPage = useCallback((direction: 1 | -1) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({
      left: direction * track.clientWidth * 0.8,
      behavior: "smooth",
    });
  }, []);

  return {
    trackRef,
    canScrollStart: edges.start,
    canScrollEnd: edges.end,
    scrollByPage,
  };
}
