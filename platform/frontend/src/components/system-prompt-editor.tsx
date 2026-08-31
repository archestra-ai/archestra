"use client";

import {
  DocsPage,
  getSystemPromptTemplateExpressions,
} from "@archestra/shared";
import type { EditorProps } from "@monaco-editor/react";
import { Maximize2, Minimize2, TriangleAlert } from "lucide-react";
import { type ReactNode, useState } from "react";

import { Editor } from "@/components/editor";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
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
  height = "200px",
  variant = "default",
  headerExtra,
  builtInAgentId,
}: {
  title?: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  height?: string;
  /** Heading treatment for standalone fields, form sections, and detail cards. */
  variant?: "default" | "section" | "detail-card";
  /** Extra element rendered in the header next to the full-screen button */
  headerExtra?: React.ReactNode;
  /** Optional built-in agent id to expose built-in-agent-specific template variables */
  builtInAgentId?: string | null;
}) {
  const docsUrl = getFrontendDocsUrl(
    DocsPage.PlatformAgents,
    "system-prompt-templating",
  );
  const [isFullScreen, setIsFullScreen] = useState(false);
  const unparseableExpressions = useUnparseableExpressions(value);
  const templateExpressions = getSystemPromptTemplateExpressions({
    builtInAgentId,
  });
  const description = (
    <>
      <span>Defines the agent&apos;s behavior. Supports </span>
      <a
        href="https://handlebarsjs.com/"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-foreground"
      >
        Handlebars
      </a>
      <span> templating.</span>
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
          <span> for available variables.</span>
        </>
      )}
    </>
  );

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          {variant !== "default" ? (
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
          )}
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
        <div className="flex items-center gap-2 shrink-0">
          {headerExtra}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setIsFullScreen(true)}
          >
            <Maximize2 className="size-4" />
            <span>Full screen</span>
          </Button>
        </div>
      </div>
      <div className="border rounded-md overflow-hidden">
        <Editor
          height={height}
          defaultLanguage="handlebars"
          value={value}
          onChange={(v) => onChange(v || "")}
          beforeMount={(monaco) => {
            registerSystemPromptCompletions(monaco, templateExpressions);
          }}
          options={{ ...SHARED_EDITOR_OPTIONS, readOnly, ariaLabel: title }}
        />
      </div>
      <UnparseableExpressionsWarning expressions={unparseableExpressions} />
      <SystemPromptFullScreenDialog
        title={title}
        open={isFullScreen}
        onOpenChange={setIsFullScreen}
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        description={description}
        headerExtra={headerExtra}
        templateExpressions={templateExpressions}
        unparseableExpressions={unparseableExpressions}
      />
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

/**
 * The same instruction, the whole viewport wide and tall: a second editor on
 * the same value, so what is typed here is in the form the moment the dialog
 * closes (or the form is saved behind it). Escape and "Exit full screen"
 * both return to the form — unless Escape is for an editor widget (the
 * suggestion list, the find box), which keeps it.
 */
function SystemPromptFullScreenDialog({
  title,
  open,
  onOpenChange,
  value,
  onChange,
  readOnly,
  description,
  headerExtra,
  templateExpressions,
  unparseableExpressions,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  description: ReactNode;
  headerExtra?: ReactNode;
  templateExpressions: TemplateExpressions;
  unparseableExpressions: string[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="h-dvh max-h-dvh w-screen max-w-none gap-0 rounded-none border-0 p-0 sm:max-w-none"
        // Focus goes to the editor once it has mounted (below), not to the
        // first button in the header.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (document.querySelector(EDITOR_WIDGET_OPEN_SELECTOR)) {
            event.preventDefault();
          }
        }}
      >
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="space-y-1">
            <DialogTitle className="text-base">{title}</DialogTitle>
            <DialogDescription className="text-xs">
              {description}
            </DialogDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerExtra}
            <DialogClose asChild>
              <Button type="button" variant="outline" size="sm">
                <Minimize2 className="size-4" />
                <span>Exit full screen</span>
              </Button>
            </DialogClose>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <Editor
            height="100%"
            defaultLanguage="handlebars"
            value={value}
            onChange={(v) => onChange(v || "")}
            beforeMount={(monaco) => {
              registerSystemPromptCompletions(monaco, templateExpressions);
            }}
            onMount={(editor) => editor.focus()}
            options={{
              ...SHARED_EDITOR_OPTIONS,
              readOnly,
              ariaLabel: title,
              // Room to read it like a document: a minimap to move around a
              // long prompt, folding for its sections, a slightly larger face.
              minimap: { enabled: true },
              folding: true,
              fontSize: 14,
              padding: { top: 12, bottom: 12 },
              renderLineHighlight: "line",
              bracketPairColorization: { enabled: true },
            }}
          />
        </div>
        {unparseableExpressions.length > 0 && (
          <div className="border-t px-4 py-3">
            <UnparseableExpressionsWarning
              expressions={unparseableExpressions}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

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

/** An editor widget that takes Escape for itself when open. */
const EDITOR_WIDGET_OPEN_SELECTOR =
  ".monaco-editor .suggest-widget.visible, .monaco-editor .find-widget.visible";

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
