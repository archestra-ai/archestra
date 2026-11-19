"use client";

import { ArrowDown, ArrowUp, Columns2 } from "lucide-react";
import { useId, useState } from "react";
import { DiffEditor } from "@/components/diff-editor";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
}: {
  before: string;
  after: string;
  path: string;
}) {
  const controlId = useId();
  const [sideBySide, setSideBySide] = useState(false);
  const navigation = usePolicyDiffNavigation();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
        <SideBySideSwitch
          id={`${controlId}-side-by-side`}
          checked={sideBySide}
          onCheckedChange={(checked) =>
            navigation.changeView(() => setSideBySide(checked))
          }
        />
        <nav
          aria-label="Change navigation"
          className="ml-auto flex w-full items-center justify-end gap-3 sm:w-auto"
        >
          <output
            aria-label="Change position"
            aria-live="polite"
            aria-atomic="true"
            className="mr-auto text-sm font-normal text-muted-foreground tabular-nums sm:mr-0"
          >
            {navigation.ready
              ? navigation.total
                ? `Change ${navigation.current} of ${navigation.total}`
                : "No changes"
              : "Calculating changes…"}
          </output>
          <div className="flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Previous change"
              title="Previous change"
              disabled={!navigation.ready || navigation.current <= 1}
              onClick={() => navigation.move(-1)}
            >
              <ArrowUp />
            </Button>
            <Button
              size="icon-sm"
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
          </div>
        </nav>
      </div>
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

function SideBySideSwitch({
  id,
  checked,
  onCheckedChange,
}: {
  id: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const description =
    "Compare current and proposed policies in two columns. Turn off for a single combined view.";
  return (
    <Tooltip delayDuration={350}>
      <div
        className={cn(
          "flex min-h-10 w-full items-center gap-3 rounded-md border px-2.5 py-1.5 transition-colors hover:bg-accent/50 sm:min-h-8 sm:w-auto",
          checked && "border-ring/40 bg-accent/60",
        )}
      >
        <Label
          htmlFor={id}
          className="flex flex-1 cursor-pointer items-center gap-2 whitespace-nowrap font-normal"
        >
          <Columns2
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-muted-foreground",
              checked && "text-foreground",
            )}
          />
          <span>Side by side view</span>
        </Label>
        {/* Tooltip and Switch each need their own data-state element. */}
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Switch
              id={id}
              aria-describedby={`${id}-description`}
              checked={checked}
              onCheckedChange={onCheckedChange}
            />
          </span>
        </TooltipTrigger>
        <span id={`${id}-description`} className="sr-only">
          {description}
        </span>
      </div>
      <TooltipContent side="bottom" className="max-w-64">
        {description}
      </TooltipContent>
    </Tooltip>
  );
}
