"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import type { ReasoningUIPart } from "ai";
import type { ComponentProps } from "react";
import { memo, useEffect, useState } from "react";
import { Collapsible } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ReasoningContext } from "./reasoning-context";

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  state?: ReasoningUIPart["state"];
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    state,
    open,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const resolvedDefaultOpen = defaultOpen ?? state === "streaming";
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
    });
    const [duration, setDuration] = useControllableState({
      prop: durationProp,
      defaultProp: 0,
    });

    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const [hasSeenStreaming, setHasSeenStreaming] = useState(
      state === "streaming",
    );
    const [startTime, setStartTime] = useState<number | null>(null);

    // Track duration when streaming starts and ends
    useEffect(() => {
      if (state === "streaming") {
        setHasSeenStreaming(true);
        if (startTime === null) {
          setStartTime(Date.now());
        }
      } else if (startTime !== null) {
        setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S));
        setStartTime(null);
      }
    }, [state, startTime, setDuration]);

    // Auto-open when streaming starts, auto-close when streaming ends (once only)
    useEffect(() => {
      if (
        resolvedDefaultOpen &&
        hasSeenStreaming &&
        state !== "streaming" &&
        isOpen &&
        !hasAutoClosed
      ) {
        // Add a small delay before closing to allow user to see the content
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosed(true);
        }, AUTO_CLOSE_DELAY);

        return () => clearTimeout(timer);
      }
    }, [
      hasAutoClosed,
      hasSeenStreaming,
      isOpen,
      resolvedDefaultOpen,
      setIsOpen,
      state,
    ]);

    const handleOpenChange = (newOpen: boolean) => {
      setIsOpen(newOpen);
    };

    return (
      <ReasoningContext.Provider value={{ state, isOpen, setIsOpen, duration }}>
        <Collapsible
          className={cn("not-prose mb-4", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

Reasoning.displayName = "Reasoning";
