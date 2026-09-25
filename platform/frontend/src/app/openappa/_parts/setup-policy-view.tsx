"use client";

import type { OnMount } from "@monaco-editor/react";
import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Editor } from "@/components/editor";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { POLICY_EDITOR_OPTIONS } from "./policy-editor-options";

type CodeEditor = Parameters<OnMount>[0];

/** Lines at Monaco's 14px font, plus the editor's top and bottom padding. */
const LINE_HEIGHT = 19;
const PADDING = 32;
const MAX_HEIGHT = 440;

/**
 * Policy text shown the way the policy page shows it, behind a toggle that is
 * always there. Lines that change while it is open flash, so a pick in the
 * rule picture visibly rewrites the text. `added` marks lines this setup adds
 * to a longer policy; the view opens scrolled to end on them.
 */
export function SetupPolicyView({
  trigger,
  content,
  ariaLabel,
  added,
  help,
}: {
  trigger: string;
  content: string;
  ariaLabel: string;
  added?: { from: number; to: number };
  /** Shown under the open text, such as a link that explains its fields. */
  help?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<CodeEditor | null>(null);
  const previous = useRef(content);
  const lineCount = content.split("\n").length;
  const addedFrom = added?.from;
  const addedTo = added?.to;

  useEffect(() => {
    if (!editor || addedFrom === undefined || addedTo === undefined) return;
    const collection = editor.createDecorationsCollection([
      {
        range: {
          startLineNumber: addedFrom,
          startColumn: 1,
          endLineNumber: addedTo,
          endColumn: 1,
        },
        options: { isWholeLine: true, className: "openappa-line-added" },
      },
    ]);
    // Scrolled just enough to end on the rule, with the policy above it. The
    // editor opens inside an animating panel, so its height settles later.
    const reveal = () => editor.revealLine(addedTo);
    reveal();
    const layout = editor.onDidLayoutChange(reveal);
    return () => {
      layout.dispose();
      collection.clear();
    };
  }, [editor, addedFrom, addedTo]);

  useEffect(() => {
    const before = previous.current.split("\n");
    previous.current = content;
    if (!editor) return;
    const changed = content
      .split("\n")
      .flatMap((line, index) => (line !== before[index] ? [index + 1] : []));
    if (changed.length === 0) return;
    const collection = editor.createDecorationsCollection(
      changed.map((line) => ({
        range: {
          startLineNumber: line,
          startColumn: 1,
          endLineNumber: line,
          endColumn: 1,
        },
        options: { isWholeLine: true, className: "openappa-line-changed" },
      })),
    );
    const timer = window.setTimeout(() => collection.clear(), 1200);
    return () => {
      window.clearTimeout(timer);
      collection.clear();
    };
  }, [editor, content]);

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // The editor unmounts with the content.
        if (!next) setEditor(null);
      }}
      className="space-y-2"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="link"
          size="sm"
          className="h-auto gap-1 px-0 [&[data-state=open]>svg]:rotate-90"
        >
          <ChevronRight className="transition-transform" />
          <span>{trigger}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden rounded-lg border bg-background">
        <Editor
          height={Math.min(lineCount * LINE_HEIGHT + PADDING, MAX_HEIGHT)}
          language="ini"
          value={content}
          onMount={setEditor}
          options={{
            ...POLICY_EDITOR_OPTIONS,
            readOnly: true,
            domReadOnly: true,
            // Numbers help find the added lines in a whole policy.
            lineNumbers: added ? "on" : "off",
            folding: false,
            renderLineHighlight: "none",
            matchBrackets: "never",
            ariaLabel,
          }}
        />
      </CollapsibleContent>
      {open && help && <p className="text-sm">{help}</p>}
    </Collapsible>
  );
}
