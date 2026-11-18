"use client";

import type { DiffOnMount } from "@monaco-editor/react";
import { ArrowDown, ArrowUp, Search, WrapText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DiffEditor } from "@/components/diff-editor";
import { Button } from "@/components/ui/button";

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
  const editorRef = useRef<Parameters<DiffOnMount>[0] | null>(null);
  const [ready, setReady] = useState(false);
  const [sideBySide, setSideBySide] = useState(false);
  const [wrap, setWrap] = useState(false);
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
    // Folding and wrapping change scroll offsets. Keep the visible policy
    // line in view after Monaco applies the new layout.
    if (line !== undefined) {
      revealFrame.current = requestAnimationFrame(() => {
        editorRef.current?.getModifiedEditor().revealLineNearTop(line);
      });
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <fieldset className="flex items-center gap-1" aria-label="Diff layout">
          <Button
            size="sm"
            variant={sideBySide ? "ghost" : "secondary"}
            aria-pressed={!sideBySide}
            onClick={() => updateView(() => setSideBySide(false))}
          >
            Unified
          </Button>
          <Button
            size="sm"
            variant={sideBySide ? "secondary" : "ghost"}
            aria-pressed={sideBySide}
            onClick={() => updateView(() => setSideBySide(true))}
          >
            Side by side
          </Button>
        </fieldset>
        <Button
          size="sm"
          variant={wrap ? "secondary" : "ghost"}
          aria-pressed={wrap}
          onClick={() => updateView(() => setWrap((value) => !value))}
        >
          <WrapText />
          <span>Wrap lines</span>
        </Button>
        <Button
          size="sm"
          variant={showUnchanged ? "secondary" : "ghost"}
          aria-pressed={showUnchanged}
          onClick={() => updateView(() => setShowUnchanged((value) => !value))}
        >
          Show unchanged
        </Button>
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
            renderSideBySide: sideBySide,
            useInlineViewWhenSpaceIsLimited: false,
            diffWordWrap: wrap ? "on" : "off",
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
