"use client";

import type { DiffOnMount } from "@monaco-editor/react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { DiffEditor } from "@/components/diff-editor";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

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
  const [showUnchanged, setShowUnchanged] = useState(false);
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
    // Folding and layout changes affect scroll offsets. Keep the visible policy
    // line in view after Monaco applies the new layout.
    if (line !== undefined) {
      revealFrame.current = requestAnimationFrame(() => {
        editorRef.current?.getModifiedEditor().revealLineNearTop(line);
      });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Switch
            id={`${controlId}-side-by-side`}
            checked={sideBySide}
            onCheckedChange={(checked) =>
              updateView(() => setSideBySide(checked))
            }
          />
          <Label
            htmlFor={`${controlId}-side-by-side`}
            className="cursor-pointer whitespace-nowrap font-normal"
          >
            Side by side
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`${controlId}-unchanged`}
            checked={showUnchanged}
            onCheckedChange={(checked) =>
              updateView(() => setShowUnchanged(checked))
            }
          />
          <Label
            htmlFor={`${controlId}-unchanged`}
            className="cursor-pointer whitespace-nowrap font-normal"
          >
            Show unchanged
          </Label>
        </div>
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
        <span className={sideBySide ? "px-4" : "px-4 text-right"}>
          {sideBySide
            ? "Proposed"
            : `Unchanged lines ${showUnchanged ? "shown" : "folded"}`}
        </span>
      </div>
      <div className="min-h-0 flex-1">
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
              enabled: !showUnchanged,
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
