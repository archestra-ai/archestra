"use client";

import { type ReactNode, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { JsonCodeBlock } from "@/components/json-code-block";
import { Button } from "@/components/ui/button";
import {
  readListedTools,
  readToolResultText,
} from "@/lib/mcp-logs/tool-call-content";
import { cn } from "@/lib/utils/tailwind";

/**
 * One block of a tool call's payload: a compact header row (its name and a
 * muted count on the left, its controls on the right) over the content, so
 * Arguments and Result read alike on every page that shows them.
 */
export function PayloadSection({
  title,
  meta,
  actions,
  children,
}: {
  title: string;
  meta?: string | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="flex h-8 items-center gap-2">
        <h3 className="text-xs font-medium">{title}</h3>
        {meta ? (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {meta}
          </span>
        ) : null}
        {actions ? (
          <div className="ml-auto flex items-center gap-1">{actions}</div>
        ) : null}
      </div>
      <div className="mt-1">{children}</div>
    </section>
  );
}

/** The arguments a call was made with, as JSON under their own header. */
export function ToolArgumentsView({ args }: { args: unknown }) {
  const fields =
    args && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args).length
      : null;
  if (args === undefined || args === null || fields === 0) {
    return (
      <PayloadSection title="Arguments">
        <EmptyNote>No arguments recorded.</EmptyNote>
      </PayloadSection>
    );
  }
  return (
    <PayloadSection
      title="Arguments"
      meta={
        fields === null ? null : fields === 1 ? "1 field" : `${fields} fields`
      }
      actions={<CopyButton text={JSON.stringify(args, null, 2)} size={12} />}
    >
      <JsonCodeBlock
        value={args}
        variant="pane"
        maxHeightClassName="max-h-[320px] overflow-auto"
      />
    </PayloadSection>
  );
}

/**
 * A logged MCP call's result, read the way it was meant: a tool's text as
 * text with line numbers, a `tools/list` as the tools it offered, and
 * anything else as JSON. The readable views keep the raw JSON one toggle
 * away.
 */
export function ToolResultView({
  method,
  result,
}: {
  method: string;
  result: unknown;
}) {
  const [showRaw, setShowRaw] = useState(false);

  if (result === null || result === undefined) {
    return (
      <PayloadSection title="Result">
        <EmptyNote>No result recorded.</EmptyNote>
      </PayloadSection>
    );
  }

  const raw = (
    <JsonCodeBlock
      value={result}
      variant="pane"
      maxHeightClassName="max-h-[640px] overflow-auto"
    />
  );
  const rawCopy = JSON.stringify(result, null, 2);
  const readable = readResult(method, result);
  if (!readable) {
    return (
      <PayloadSection
        title="Result"
        actions={<CopyButton text={rawCopy} size={12} />}
      >
        {raw}
      </PayloadSection>
    );
  }

  return (
    <PayloadSection
      title="Result"
      meta={showRaw ? null : readable.meta}
      actions={
        <>
          <fieldset
            aria-label="Result view"
            className="inline-flex rounded-md border bg-muted/40 p-px"
          >
            <ViewButton pressed={!showRaw} onClick={() => setShowRaw(false)}>
              {readable.label}
            </ViewButton>
            <ViewButton pressed={showRaw} onClick={() => setShowRaw(true)}>
              Raw JSON
            </ViewButton>
          </fieldset>
          <CopyButton
            text={showRaw ? rawCopy : (readable.copy ?? rawCopy)}
            size={12}
          />
        </>
      }
    >
      {showRaw ? raw : readable.view}
    </PayloadSection>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/** Lines shown before "Show all N lines". */
const PREVIEW_LINES = 40;

function readResult(
  method: string,
  result: unknown,
): {
  label: string;
  meta: string | null;
  copy?: string;
  view: ReactNode;
} | null {
  if (method === "tools/list") {
    const tools = readListedTools(result);
    if (!tools) return null;
    return {
      label: "Tools",
      meta: tools.length === 1 ? "1 tool" : `${tools.length} tools`,
      copy: tools.map((tool) => tool.name).join("\n"),
      view:
        tools.length === 0 ? (
          <EmptyNote>The server listed no tools.</EmptyNote>
        ) : (
          <ul
            aria-label="Listed tools"
            className="divide-y divide-border/60 rounded-lg border bg-background text-xs"
          >
            {tools.map((tool) => (
              <li key={tool.name} className="px-3 py-1.5">
                <div className="font-mono font-medium break-all">
                  {tool.name}
                </div>
                {tool.description ? (
                  <p className="line-clamp-2 text-muted-foreground">
                    {tool.description}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ),
    };
  }
  if (method !== "tools/call") return null;

  const text = readToolResultText(result);
  if (text !== null) {
    const lines = toLines(text);
    return {
      label: "Text",
      meta: lines.length === 1 ? "1 line" : `${lines.length} lines`,
      copy: lines.join("\n"),
      view: <NumberedLines lines={lines} />,
    };
  }
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content) && content.length === 0) {
    return {
      label: "Text",
      meta: null,
      view: <EmptyNote>The tool returned no content.</EmptyNote>,
    };
  }
  return null;
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function ViewButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "font-normal text-muted-foreground",
        pressed && "bg-background text-foreground shadow-xs",
      )}
    >
      <span>{children}</span>
    </Button>
  );
}

/**
 * Text with a line-number gutter. A long line wraps with a hanging indent,
 * so its continuation stays clear of the gutter.
 */
function NumberedLines({ lines }: { lines: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? lines : lines.slice(0, PREVIEW_LINES);
  const hidden = lines.length - visible.length;
  const gutter = `${String(lines.length).length + 2}ch`;
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <ol
        aria-label="Result text"
        className="py-1.5 font-mono text-xs leading-5"
      >
        {visible.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a line's position is its identity in this static text
          <li key={index} className="flex">
            <span
              aria-hidden="true"
              className="shrink-0 pr-2.5 text-right text-muted-foreground/60 tabular-nums select-none"
              style={{ width: gutter }}
            >
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap">
              {line || " "}
            </span>
          </li>
        ))}
      </ol>
      {hidden > 0 ? (
        <div className="border-t bg-muted/30 px-2 py-1">
          <Button variant="ghost" size="xs" onClick={() => setExpanded(true)}>
            <span>Show all {lines.length.toLocaleString()} lines</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A text's lines, with a single-line JSON document pretty-printed first. */
function toLines(text: string): string[] {
  const trimmed = text.trim();
  if (
    !trimmed.includes("\n") &&
    (trimmed.startsWith("{") || trimmed.startsWith("["))
  ) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2).split("\n");
    } catch {
      // Not JSON after all; show it as written.
    }
  }
  return text.split("\n");
}
