"use client";

import { BUILT_IN_AGENT_NAMES } from "@archestra/shared";
import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppaKeeperIcon } from "@/components/appa-keeper-icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { OPENAPPA_SUGGESTED_LAUNCH_PROMPTS } from "@/lib/openappa-chat-prompts";
import { cn } from "@/lib/utils/tailwind";
import { OpenAppaChatButton } from "./openappa-chat-button";

/** The agent's suggested prompts, as the chat shows them: title as the label. */
const QUESTIONS = Object.entries(OPENAPPA_SUGGESTED_LAUNCH_PROMPTS).map(
  ([promptKey, suggested]) => ({
    promptKey: promptKey as keyof typeof OPENAPPA_SUGGESTED_LAUNCH_PROMPTS,
    label: suggested.summaryTitle,
  }),
);

/**
 * Ways into the configuration agent: a plain chat that opens on the agent's
 * suggested prompts, then those same prompts, each sending itself. The
 * prompts sit on one row that scrolls sideways when it does not fit, so the
 * card keeps one height however narrow the page is.
 */
export function OpenAppaChatStrip() {
  const agentName = BUILT_IN_AGENT_NAMES.OPENAPPA_CONFIG;
  const { trackRef, canScrollStart, canScrollEnd, scrollByPage } =
    useHorizontalScroll();

  return (
    <Card className="gap-3 px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3">
        <div className="flex min-w-[12rem] flex-1 items-center gap-3">
          <div
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40 [&>svg]:size-5"
          >
            <AppaKeeperIcon />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">{`Ask ${agentName}`}</h2>
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
      <div className="relative -mx-4">
        <ul
          ref={trackRef}
          aria-label={`Suggested questions for ${agentName}`}
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
    </Card>
  );
}

// ===

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
