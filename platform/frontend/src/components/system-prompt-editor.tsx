"use client";

import { DocsPage, SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS } from "@shared";
import { Maximize2, Minimize2 } from "lucide-react";
import { useState } from "react";

import { Editor } from "@/components/editor";
import { Button } from "@/components/ui/button";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import {
  computeHandlebarsReplaceOffsets,
  shouldShowHandlebarsCompletions,
} from "@/lib/utils/handlebars-completion";

export function SystemPromptEditor({
  value,
  onChange,
  readOnly,
  height = "200px",
  expandedHeight = "420px",
  variant = "default",
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  height?: string;
  expandedHeight?: string;
  /** "section" uses bold h3 (matching section headings), "default" uses lighter text */
  variant?: "default" | "section";
}) {
  const docsUrl = getFrontendDocsUrl(
    DocsPage.PlatformAgents,
    "system-prompt-templating",
  );
  const [isExpanded, setIsExpanded] = useState(false);
  const editorHeight = isExpanded ? expandedHeight : height;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          {variant === "section" ? (
            <h3 className="text-sm font-semibold">Instruction</h3>
          ) : (
            <p className="text-sm font-medium">Instruction</p>
          )}
          <p className="text-xs text-muted-foreground">
            System prompt used by the agent. Supports{" "}
            <a
              href="https://handlebarsjs.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              Handlebars
            </a>{" "}
            templating
            {docsUrl ? (
              <>
                {" "}
                — see{" "}
                <a
                  href={docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                >
                  docs
                </a>{" "}
                for available variables.
              </>
            ) : (
              "."
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setIsExpanded((current) => !current)}
        >
          {isExpanded ? (
            <Minimize2 className="size-4" />
          ) : (
            <Maximize2 className="size-4" />
          )}
          <span>{isExpanded ? "Collapse" : "Expand"}</span>
        </Button>
      </div>
      <div className="border rounded-md overflow-hidden">
        <Editor
          height={editorHeight}
          defaultLanguage="handlebars"
          value={value}
          onChange={(v) => onChange(v || "")}
          beforeMount={(monaco) => {
            registerSystemPromptCompletions(monaco);
          }}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            scrollbar: { alwaysConsumeMouseWheel: false },
            wordWrap: "on",
            automaticLayout: true,
            readOnly,
            placeholder: "Enter instruction for the LLM",
            quickSuggestions: false,
            wordBasedSuggestions: "off",
            // Disable EditContext API — it doesn't work inside Radix Dialog portals
            editContext: false,
          }}
        />
      </div>
    </div>
  );
}

// ===
// Internal helpers
// ===

let completionsRegistered = false;

type Monaco = Parameters<
  NonNullable<import("@monaco-editor/react").EditorProps["beforeMount"]>
>[0];

function registerSystemPromptCompletions(monaco: Monaco) {
  if (completionsRegistered) return;
  completionsRegistered = true;

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
      suggestions: SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS.map((v) => ({
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
