"use client";

import type { DiffOnMount } from "@monaco-editor/react";
import { ArrowDown, ArrowUp, Columns2, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
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
  const editorRef = useRef<Parameters<DiffOnMount>[0] | null>(null);
  const [ready, setReady] = useState(false);
  const [sideBySide, setSideBySide] = useState(false);
  const revealFrame = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (revealFrame.current !== null)
        cancelAnimationFrame(revealFrame.current);
      editorRef.current = null;
    },
    [],
  );

  function updateView(update: () => void) {
    const line = editorRef.current
      ?.getModifiedEditor()
      .getVisibleRanges()[0]?.startLineNumber;
    update();
    if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
    // Layout changes affect scroll offsets. Keep the visible policy
    // line in view after Monaco applies the new layout.
    if (line !== undefined) {
      revealFrame.current = requestAnimationFrame(() => {
        editorRef.current?.getModifiedEditor().revealLineNearTop(line);
      });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-3">
        <SideBySideSwitch
          id={`${controlId}-side-by-side`}
          checked={sideBySide}
          onCheckedChange={(checked) =>
            updateView(() => setSideBySide(checked))
          }
        />
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={!ready}
            onClick={() => {
              const editor = editorRef.current?.getModifiedEditor();
              editor?.focus();
              void editor?.getAction("actions.find")?.run();
            }}
          >
            <Search />
            <span>Find</span>
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Previous change"
            title="Previous change"
            disabled={!ready}
            onClick={() => editorRef.current?.goToDiff("previous")}
          >
            <ArrowUp />
          </Button>
          <Button
            size="icon-sm"
            variant="outline"
            aria-label="Next change"
            title="Next change"
            disabled={!ready}
            onClick={() => editorRef.current?.goToDiff("next")}
          >
            <ArrowDown />
          </Button>
        </div>
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
          onMount={(editor) => {
            editorRef.current = editor;
            setReady(true);
            editor.revealFirstDiff();
          }}
          options={{
            automaticLayout: true,
            // Large policy rewrites can exceed Monaco's five-second default
            // and fall back to treating the entire file as changed.
            maxComputationTime: 30_000,
            renderSideBySide: sideBySide,
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
