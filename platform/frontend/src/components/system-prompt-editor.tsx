"use client";

import {
  DocsPage,
  getDocsUrl,
  SYSTEM_PROMPT_TEMPLATE_EXPRESSIONS,
} from "@shared";
import Link from "next/link";

import { Editor } from "@/components/editor";
import { Label } from "@/components/ui/label";
import { computeHandlebarsReplaceOffsets } from "@/lib/handlebars-completion";

export function SystemPromptEditor({
  value,
  onChange,
  readOnly,
  height = "200px",
}: {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  height?: string;
}) {
  return (
    <div className="space-y-2">
      <Label>Instructions</Label>
      <p className="text-xs text-muted-foreground">
        Supports{" "}
        <Link
          href="https://handlebarsjs.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          Handlebars
        </Link>{" "}
        templating. See{" "}
        <a
          href={getDocsUrl(DocsPage.PlatformAgents, "system-prompt-templating")}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          docs
        </a>{" "}
        for details and all available variables and functions.
      </p>
      <div className="border rounded-md overflow-hidden">
        <Editor
          height={height}
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
            wordWrap: "on",
            automaticLayout: true,
            readOnly,
            placeholder: "Enter instruction for the LLM",
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
    const { startOffset, endOffset } = computeHandlebarsReplaceOffsets(
      lineContent.substring(0, col - 1),
      lineContent.substring(col - 1),
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
