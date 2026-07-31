"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { Response } from "./response";

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  // Undefined until a live block measures its own duration (or a caller passes
  // one); a persisted block never has it. `getThinkingMessage` distinguishes the
  // two, so the type must admit undefined.
  duration: number | undefined;
  // True while more thinking may still join a merged run. Any duration measured
  // so far is a partial sum, so the trigger keeps reading "Thinking…" rather
  // than announcing a total it is about to revise upward.
  keepOpen: boolean;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
  /**
   * More content may still arrive — hold the auto-close. A merged run of
   * thinking blocks streams in bursts with tool calls in between; without this
   * it would collapse and re-expand once per burst.
   */
  keepOpen?: boolean;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    // A block that mounts mid-stream starts open; a persisted block (a
    // reopened conversation) mounts collapsed, so loading a chat doesn't flash
    // every thinking accordion open and then auto-close it one second later.
    defaultOpen = isStreaming,
    onOpenChange,
    duration: durationProp,
    keepOpen = false,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });
    const [duration, setDuration] = useControllableState({
      prop: durationProp,
      // Undefined, not 0: a reasoning block that never streamed (a persisted
      // conversation reopened, or a surface that passes no `isStreaming`) has no
      // measured duration and must read "Thought for a few seconds", not stay
      // pinned on "Thinking…". A live block still gets a real duration from the
      // streaming-end effect below.
      defaultProp: undefined,
    });

    const [hasAutoClosed, setHasAutoClosed] = useState(false);
    const [hasStreamed, setHasStreamed] = useState(isStreaming);
    const [startTime, setStartTime] = useState<number | null>(null);
    // A merged run of thinking blocks streams in several bursts, one per block,
    // with the tool calls it swallowed in between. Accumulate the streaming
    // intervals so the label reports total thinking time: overwriting would
    // report only the final block, and wall-clock would fold in the tool runs.
    // A single-burst block accumulates exactly its own interval, as before.
    const streamedMsRef = useRef(0);

    // Track duration when streaming starts and ends
    useEffect(() => {
      if (isStreaming) {
        setHasStreamed(true);
        if (startTime === null) {
          setStartTime(Date.now());
        }
      } else if (startTime !== null) {
        streamedMsRef.current += Date.now() - startTime;
        setDuration(Math.ceil(streamedMsRef.current / MS_IN_S));
        setStartTime(null);
      }
    }, [isStreaming, startTime, setDuration]);

    // Auto-close once, shortly after a live block finishes streaming. Gated on
    // hasStreamed rather than defaultOpen — defaultOpen tracks isStreaming and
    // is already false again on the render where streaming ends — and so that
    // persisted blocks, which never streamed in this mount, stay put instead of
    // flicker-closing on conversation load. `keepOpen` defers it while more
    // thinking may still join a merged run, so the row opens and closes exactly
    // once across the run rather than flickering between blocks.
    useEffect(() => {
      if (
        hasStreamed &&
        !isStreaming &&
        !keepOpen &&
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
    }, [isStreaming, isOpen, hasStreamed, setIsOpen, hasAutoClosed, keepOpen]);

    const handleOpenChange = (newOpen: boolean) => {
      setIsOpen(newOpen);
    };

    return (
      <ReasoningContext.Provider
        value={{ isStreaming, isOpen, setIsOpen, duration, keepOpen }}
      >
        <Collapsible
          className={cn("not-prose mb-4 pl-2", className)}
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

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger>;

const getThinkingMessage = (isStreaming: boolean, duration?: number) => {
  if (isStreaming || duration === 0) {
    return <p>Thinking...</p>;
  }
  if (duration === undefined) {
    return <p>Thought for a few seconds</p>;
  }
  return <p>Thought for {duration} seconds</p>;
};

export const ReasoningTrigger = memo(
  ({ className, children, ...props }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration, keepOpen } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4" />
            {getThinkingMessage(isStreaming || keepOpen, duration)}
            <ChevronDownIcon
              className={cn(
                "size-4 transition-transform",
                isOpen ? "rotate-180" : "rotate-0",
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      className={cn(
        "mt-4 text-sm",
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className,
      )}
      {...props}
    >
      <Response className="grid gap-2">{children}</Response>
    </CollapsibleContent>
  ),
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
