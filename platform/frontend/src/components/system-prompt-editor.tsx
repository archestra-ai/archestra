"use client";

import {
  DocsPage,
  getSystemPromptTemplateExpressions,
} from "@archestra/shared";
import type { EditorProps } from "@monaco-editor/react";
import { TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";

import { Editor } from "@/components/editor";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import {
  computeHandlebarsReplaceOffsets,
  shouldShowHandlebarsCompletions,
} from "@/lib/utils/handlebars-completion";
import { useUnparseableExpressions } from "@/lib/utils/handlebars-validation";

export function SystemPromptEditor({
  title = "Instruction",
  value,
  onChange,
  readOnly,
  minHeight = 200,
  maxHeight = 560,
  variant = "default",
  showTitle = true,
  headerExtra,
  builtInAgentId,
}: {
  title?: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  /** Floor for the auto-grown box, in px, and where a drag bottoms out. */
  minHeight?: number;
  /**
   * Ceiling for the auto growth, in px — past it the editor scrolls rather
   * than pushing the rest of the form off the screen. A drag is the reader
   * saying they want more than this, so it is not clamped by it.
   */
  maxHeight?: number;
  /** Heading treatment for standalone fields, form sections, and detail cards. */
  variant?: "default" | "section" | "detail-card";
  /**
   * Off where the host already names the editor. `title` still labels the
   * editor for assistive technology — it is only the visible duplicate that
   * goes.
   */
  showTitle?: boolean;
  /** Extra element rendered in the header, beside the title. */
  headerExtra?: React.ReactNode;
  /** Optional built-in agent id to expose built-in-agent-specific template variables */
  builtInAgentId?: string | null;
}) {
  const docsUrl = getFrontendDocsUrl(
    DocsPage.PlatformAgents,
    "system-prompt-templating",
  );
  // What the text wants, and what the reader has asked for by dragging. A
  // drag raises the floor rather than freezing the box, so the editor still
  // grows under the next line typed into it; dragging it past the ceiling
  // raises that too, since asking for a bigger box is the one case where the
  // ceiling is not what the reader wants.
  const [contentHeight, setContentHeight] = useState(minHeight);
  const [draggedHeight, setDraggedHeight] = useState<number | null>(null);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const floor = draggedHeight ?? minHeight;
  const editorHeight = Math.min(
    Math.max(contentHeight, floor),
    Math.max(maxHeight, floor),
  );
  const unparseableExpressions = useUnparseableExpressions(value);
  const templateExpressions = getSystemPromptTemplateExpressions({
    builtInAgentId,
  });
  // One line, and one link — ours. What the field is for is already said by
  // the label above it, and sending a reader to handlebarsjs.com answered a
  // question the variables list answers better.
  const description = (
    <>
      <span>Supports Handlebars templating.</span>
      {docsUrl && (
        <>
          <span> See </span>
          <ExternalDocsLink
            href={docsUrl}
            className="underline hover:text-foreground"
            showIcon={false}
          >
            docs
          </ExternalDocsLink>
          <span> for variables.</span>
        </>
      )}
    </>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          {showTitle &&
            (variant !== "default" ? (
              <h3
                className={
                  variant === "detail-card"
                    ? "text-sm font-semibold"
                    : "text-base font-semibold"
                }
              >
                {title}
              </h3>
            ) : (
              <p className="text-sm font-medium">{title}</p>
            ))}
          <p
            className={
              variant === "detail-card"
                ? "text-sm text-muted-foreground"
                : "text-xs text-muted-foreground"
            }
          >
            {description}
          </p>
        </div>
        {headerExtra && (
          <div className="flex shrink-0 items-center gap-2">{headerExtra}</div>
        )}
      </div>
      <div className="relative overflow-hidden rounded-md border">
        <div style={{ height: editorHeight }}>
          <Editor
            height="100%"
            defaultLanguage="handlebars"
            value={value}
            onChange={(v) => onChange(v || "")}
            beforeMount={(monaco) => {
              registerSystemPromptCompletions(monaco, templateExpressions);
            }}
            onMount={(editor) => {
              // Monaco reports the height its content wants; the box follows
              // it until the ceiling, after which the editor scrolls.
              const sync = () => setContentHeight(editor.getContentHeight());
              sync();
              editor.onDidContentSizeChange(sync);
            }}
            options={{ ...SHARED_EDITOR_OPTIONS, readOnly, ariaLabel: title }}
          />
        </div>
        {/* The corner grip a textarea has, in the same place, so the two
            fields of this form resize the same way. The arrow keys move it
            too, so it is not a mouse-only control. */}
        {/* biome-ignore lint/a11y/useSemanticElements: a resize grip between
            two regions is what `separator` names; <hr> is not focusable and
            carries no orientation. */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={`Resize ${title.toLowerCase()}`}
          // A focusable separator is a window splitter, and states where it
          // currently sits.
          aria-valuenow={editorHeight}
          aria-valuemin={minHeight}
          tabIndex={0}
          className="absolute bottom-0 right-0 flex size-4 cursor-ns-resize items-end justify-end p-0.5 text-muted-foreground/60 outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {
              startY: event.clientY,
              startHeight: editorHeight,
            };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag) return;
            setDraggedHeight(
              Math.max(
                minHeight,
                drag.startHeight + (event.clientY - drag.startY),
              ),
            );
          }}
          onPointerUp={(event) => {
            dragRef.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const step = event.key === "ArrowDown" ? RESIZE_STEP : -RESIZE_STEP;
            setDraggedHeight(Math.max(minHeight, editorHeight + step));
          }}
        >
          {/* The same two diagonal ticks the native textarea grip draws. */}
          <svg
            viewBox="0 0 10 10"
            className="size-2.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <title>Resize</title>
            <path d="M9 1 1 9M9 5.5 5.5 9" />
          </svg>
        </div>
      </div>
      <UnparseableExpressionsWarning expressions={unparseableExpressions} />
    </div>
  );
}

// ===
// Internal helpers
// ===

/**
 * Names the expressions Handlebars cannot parse. They are rendered as the
 * literal text the author typed rather than dropped, so this is a warning and
 * not an error — but an author who meant to interpolate a value has no other
 * way to find out before a model reads the braces back to a user.
 */
function UnparseableExpressionsWarning({
  expressions,
}: {
  expressions: string[];
}) {
  if (expressions.length === 0) return null;

  const shown = [...new Set(expressions)].slice(0, UNPARSEABLE_SHOWN_MAX);

  return (
    <p className="text-xs text-amber-600 dark:text-amber-500">
      <TriangleAlert className="mr-1 inline size-3.5 align-[-2px]" />
      {shown.length === 1
        ? "This expression isn't valid Handlebars and will appear literally in the prompt: "
        : "These expressions aren't valid Handlebars and will appear literally in the prompt: "}
      {shown.map((expression, index) => (
        <span key={expression}>
          {index > 0 && <span>, </span>}
          <code className="font-mono">{expression}</code>
        </span>
      ))}
      {expressions.length > shown.length && <span>, …</span>}
      {". Prefix one with a backslash to keep it as literal text on purpose."}
    </p>
  );
}

/** Enough to act on without turning the warning into a second prompt. */
const UNPARSEABLE_SHOWN_MAX = 5;

/** How far one arrow-key press moves the resize grip. */
const RESIZE_STEP = 24;

const SHARED_EDITOR_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 13,
  lineNumbers: "on",
  scrollBeyondLastLine: false,
  scrollbar: { alwaysConsumeMouseWheel: false },
  wordWrap: "on",
  automaticLayout: true,
  placeholder: "Enter instruction for the LLM",
  quickSuggestions: false,
  wordBasedSuggestions: "off",
  // Disable EditContext API — it doesn't work inside Radix Dialog portals
  editContext: false,
} as const satisfies NonNullable<EditorProps["options"]>;

type TemplateExpressions = ReadonlyArray<{
  expression: string;
  description: string;
}>;

let completionsProviderRegistered = false;
let currentTemplateExpressions: TemplateExpressions = [];

type Monaco = Parameters<NonNullable<EditorProps["beforeMount"]>>[0];

function registerSystemPromptCompletions(
  monaco: Monaco,
  templateExpressions: TemplateExpressions,
) {
  currentTemplateExpressions = templateExpressions;

  if (completionsProviderRegistered) return;
  completionsProviderRegistered = true;

  // biome-ignore lint/suspicious/noExplicitAny: Monaco namespace types aren't directly indexable
  const provideCompletionItems = (model: any, position: any) => {
    const lineContent = model.getLineContent(position.lineNumber) as string;
    const col = position.column as number;
    const textBeforeCursor = lineContent.substring(0, col - 1);
    const textAfterCursor = lineContent.substring(col - 1);

    if (!shouldShowHandlebarsCompletions(textBeforeCursor)) {
      return { suggestions: [] };
    }

    const { startOffset, endOffset } = computeHandlebarsReplaceOffsets(
      textBeforeCursor,
      textAfterCursor,
    );
    const range = {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: col - startOffset,
      endColumn: col + endOffset,
    };
    return {
      suggestions: currentTemplateExpressions.map((v) => ({
        label: v.expression,
        kind: monaco.languages.CompletionItemKind.Variable,
        insertText: v.expression,
        detail: v.description,
        range,
      })),
    };
  };
  monaco.languages.registerCompletionItemProvider("handlebars", {
    triggerCharacters: ["{"],
    provideCompletionItems,
  });
}
