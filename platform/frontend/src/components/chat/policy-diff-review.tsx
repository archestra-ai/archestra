"use client";

import { ArrowDown, ArrowUp, Columns2, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { DiffEditor } from "@/components/diff-editor";
import { Button } from "@/components/ui/button";
import {
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils/tailwind";
import styles from "./policy-diff-review.module.css";
import { usePolicyDiffNavigation } from "./use-policy-diff-navigation";

/** Monaco renders only visible lines and keeps navigation within the review. */
export function PolicyDiffReview({
  before,
  after,
  path,
  summary,
}: {
  before: string;
  after: string;
  path: string;
  summary: ReactNode;
}) {
  const controlId = useId();
  const [sideBySide, setSideBySide] = useState(false);
  const navigation = usePolicyDiffNavigation(sideBySide);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DialogHeader className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 text-left md:gap-y-6">
        <DialogTitle className="flex min-h-8 min-w-0 items-center font-mono text-base font-medium">
          {path}
        </DialogTitle>
        <DialogDescription
          asChild
          className="col-span-full row-start-2 text-xs md:col-span-1"
        >
          {summary}
        </DialogDescription>
        <div className="col-span-full row-start-3 mt-4 flex min-w-0 flex-wrap items-center justify-end gap-x-4 gap-y-2 md:col-span-1 md:col-start-2 md:row-start-2 md:mt-0">
          <SideBySideButton
            id={`${controlId}-side-by-side`}
            pressed={sideBySide}
            onPressedChange={(pressed) =>
              navigation.changeView(() => setSideBySide(pressed))
            }
          />
          <nav
            aria-label="Change navigation"
            className="flex items-center gap-2"
          >
            <output
              aria-label="Change position"
              aria-live="polite"
              aria-atomic="true"
              className="whitespace-nowrap text-xs font-normal text-muted-foreground tabular-nums"
            >
              {navigation.ready
                ? navigation.total
                  ? `Change ${navigation.current} of ${navigation.total}`
                  : "No changes"
                : "Calculating changes…"}
            </output>
            <div className="flex items-center gap-1">
              <Button
                size="icon-xs"
                variant="outline"
                aria-label="Next change"
                title="Next change"
                disabled={
                  !navigation.ready || navigation.current >= navigation.total
                }
                onClick={() => navigation.move(1)}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon-xs"
                variant="outline"
                aria-label="Previous change"
                title="Previous change"
                disabled={!navigation.ready || navigation.current <= 1}
                onClick={() => navigation.move(-1)}
              >
                <ArrowUp />
              </Button>
            </div>
          </nav>
        </div>
        <DialogClose asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close"
            className="col-start-2 row-start-1 justify-self-end text-muted-foreground"
          >
            <X />
          </Button>
        </DialogClose>
      </DialogHeader>
      <div className="grid shrink-0 grid-cols-2 border-b bg-muted/30 py-2 text-xs text-muted-foreground">
        <span className="px-4">
          {sideBySide ? "Current" : "Current → Proposed"}
        </span>
        {sideBySide && <span className="px-4">Proposed</span>}
      </div>
      <div className={cn("min-h-0 flex-1", styles.editor)}>
        <DiffEditor
          original={before}
          modified={after}
          language={path.endsWith(".json") ? "json" : "plaintext"}
          height="100%"
          loading={
            <output className="p-4 text-sm text-muted-foreground">
              Loading full diff…
            </output>
          }
          onMount={(editor, monaco) => {
            // Both panes scroll together; only the proposed pane needs a track.
            editor.getOriginalEditor().updateOptions({
              scrollbar: { vertical: "hidden", verticalScrollbarSize: 0 },
            });
            navigation.onMount(editor, monaco);
          }}
          options={{
            automaticLayout: true,
            // Large policy rewrites can exceed Monaco's five-second default
            // and fall back to treating the entire file as changed.
            maxComputationTime: 30_000,
            renderSideBySide: sideBySide,
            renderOverviewRuler: false,
            useInlineViewWhenSpaceIsLimited: false,
            diffWordWrap: "off",
            hideUnchangedRegions: {
              enabled: true,
              contextLineCount: 3,
            },
            ignoreTrimWhitespace: false,
            originalEditable: false,
            renderMarginRevertIcon: false,
            renderGutterMenu: false,
            fontSize: 13,
            lineNumbersMinChars: 6,
            originalAriaLabel: "Current policy",
            modifiedAriaLabel: "Proposed policy",
            padding: { top: 12, bottom: 12 },
          }}
        />
      </div>
    </div>
  );
}

function SideBySideButton({
  id,
  pressed,
  onPressedChange,
}: {
  id: string;
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
}) {
  const description =
    "Compare current and proposed policies in two columns. Turn off for a single combined view.";
  return (
    <Tooltip delayDuration={350}>
      <TooltipTrigger asChild>
        <Button
          id={id}
          size="xs"
          variant={pressed ? "default" : "outline"}
          aria-pressed={pressed}
          aria-describedby={`${id}-description`}
          onClick={() => onPressedChange(!pressed)}
          className={cn(
            "shrink-0 border",
            pressed
              ? "border-primary"
              : "text-muted-foreground hover:border-foreground hover:bg-foreground hover:text-background dark:hover:bg-foreground",
          )}
        >
          <Columns2 aria-hidden="true" />
          <span>Side by side view</span>
        </Button>
      </TooltipTrigger>
      <span id={`${id}-description`} className="sr-only">
        {description}
      </span>
      <TooltipContent side="bottom" className="max-w-64">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}
