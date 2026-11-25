"use client";

import type { ToolUIPart } from "ai";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, useContext, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils/tailwind";
import { CodeBlock } from "./code-block";
import {
  TRUNCATED_CONTENT_MAX_LINES,
  TruncatedContent,
} from "./truncated-content";

export type ToolProps = ComponentProps<typeof Collapsible>;

const ToolContext = createContext<{ hasOpened: boolean }>({ hasOpened: false });

export const Tool = ({
  className,
  onOpenChange,
  open,
  children,
  ...props
}: ToolProps) => {
  const [hasOpened, setHasOpened] = useState<boolean>(
    open ?? Boolean((props as Record<string, unknown>).defaultOpen) ?? true,
  );

  const handleOpenChange = (open: boolean) => {
    if (open) setHasOpened(true);
    onOpenChange?.(open);
  };

  return (
    <ToolContext.Provider value={{ hasOpened: hasOpened || !!open }}>
      <Collapsible
        defaultOpen={false}
        open={open}
        className={cn(
          "not-prose mb-4 w-full overflow-hidden rounded-lg border border-border/60 bg-card shadow-sm",
          className,
        )}
        onOpenChange={handleOpenChange}
        {...props}
      >
        {children}
      </Collapsible>
    </ToolContext.Provider>
  );
};

export type ToolHeaderProps = {
  title?: string;
  type: ToolUIPart["type"];
  state: ToolHeaderState;
  className?: string;
  icon?: React.ReactNode;
  isCollapsible?: boolean;
  /** Optional action button to display in the header (e.g., View Logs) */
  actionButton?: React.ReactNode;
  /** Names the identity the call ran as upstream (e.g. whose connection served it) */
  identityBadge?: React.ReactNode;
  /** Replaces the state's default status text, keeping its dot */
  statusLabel?: string;
};

/**
 * A tool call's state as its header shows it: the SDK's states, plus the ones
 * only the platform knows.
 */
type ToolHeaderState =
  | ToolUIPart["state"]
  | "output-denied"
  | "output-cancelled"
  | "input-queued";

const getStatusBadge = (status: ToolHeaderState, label?: string) => {
  const labels = {
    "input-streaming": "Pending",
    // The call waits for a free place on its server: it has not started.
    "input-queued": "Queued",
    "input-available": "Running",
    "approval-requested": "Approval requested",
    "approval-responded": "Approval responded",
    "output-available": "Completed",
    "output-error": "Error",
    "output-denied": "Denied",
    // A user-stopped call: neither a success nor a failure, so it gets a
    // neutral label and a muted dot rather than green or red.
    "output-cancelled": "Cancelled",
  } as const;

  const dotClass = {
    "input-streaming": "bg-muted-foreground/50",
    "input-queued": "bg-blue-500/40",
    "input-available": "bg-blue-500 animate-pulse",
    "approval-requested": "bg-amber-500",
    "approval-responded": "bg-blue-500",
    "output-available": "bg-emerald-500",
    "output-error": "bg-destructive",
    "output-denied": "bg-orange-500",
    "output-cancelled": "bg-muted-foreground",
  } as const;

  return (
    <div className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", dotClass[status])} />
      {label ?? labels[status]}
    </div>
  );
};

export const ToolHeader = ({
  className,
  title,
  type,
  state,
  icon,
  isCollapsible = true,
  actionButton,
  identityBadge,
  statusLabel,
  ...props
}: ToolHeaderProps) => {
  const name = title ?? type.split("-").slice(1).join("-");
  return (
    <CollapsibleTrigger
      className={cn(
        "group flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border/60 bg-muted/40 px-3 py-2 cursor-pointer",
        isCollapsible ? "cursor-pointer" : "!cursor-default",
        className,
      )}
      {...props}
    >
      {/* The name is never cut: in a narrow card the status moves to its own
        line, and a name wider than the card breaks across lines, inside a
        word when the name has no break point. */}
      <div className="flex min-w-[min(100%,14rem)] max-w-full flex-1 items-center gap-2">
        {icon}
        <span
          className="min-w-0 text-left font-mono text-xs font-medium text-foreground [overflow-wrap:anywhere]"
          title={name}
        >
          {name}
        </span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        {identityBadge}
        {getStatusBadge(state, statusLabel)}
        {actionButton && (
          // biome-ignore lint/a11y/noStaticElementInteractions: Wrapper needs to stop event propagation
          <div
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {actionButton}
          </div>
        )}
        {isCollapsible && (
          <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        )}
      </div>
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = Omit<
  ComponentProps<typeof CollapsibleContent>,
  "forceMount"
> & {
  /** Keep children mounted even when closed (useful for MCP apps that need to preserve iframe state) */
  forceMount?: boolean;
};

export const ToolContent = ({
  className,
  children,
  forceMount = false,
  ...props
}: ToolContentProps) => {
  const { hasOpened } = useContext(ToolContext);

  const resolvedClassName = cn(
    "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
    forceMount &&
      "overflow-hidden data-[state=closed]:max-h-0 data-[state=open]:max-h-[5000px]",
    className,
  );

  if (forceMount) {
    return (
      <CollapsibleContent className={resolvedClassName} forceMount {...props}>
        {children}
      </CollapsibleContent>
    );
  }

  return (
    <CollapsibleContent className={resolvedClassName} {...props}>
      {hasOpened ? children : null}
    </CollapsibleContent>
  );
};

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
  /** Deprecated — parameters are always rendered expanded. */
  defaultOpen?: boolean;
};

export const ToolInput = ({
  className,
  input,
  defaultOpen: _defaultOpen,
  ...props
}: ToolInputProps) => {
  return (
    <div
      className={cn("overflow-hidden p-3 space-y-1.5", className)}
      {...props}
    >
      <SectionLabel accent="bg-sky-400">Request</SectionLabel>
      <ToolInputBody input={input} />
    </div>
  );
};

export const SectionLabel = ({
  children,
  accent,
}: {
  children: ReactNode;
  accent: string;
}) => (
  <div className="flex items-center gap-2">
    <span className={cn("h-3 w-[3px] rounded-full", accent)} />
    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  </div>
);

/**
 * Parameters body. An object input carrying a multi-line string value (e.g.
 * run_command's `command`, file contents) renders one block per field with
 * real line breaks instead of `\n` escapes inside a JSON dump — and the copy
 * button copies the raw value, ready to paste into a terminal. Everything
 * else keeps the compact pretty-printed JSON view.
 */
const ToolInputBody = ({ input }: { input: ToolUIPart["input"] }) => {
  const entries = getEntriesWithMultilineStrings(input);

  if (!entries) {
    const serializedInput = JSON.stringify(input, null, 2);
    return (
      <TruncatedCodeBlock
        code={serializedInput}
        language="json"
        copyText={serializedInput}
      />
    );
  }

  return (
    <dl className="space-y-3">
      {entries.map(([key, value]) => {
        const isString = typeof value === "string";
        const code = isString ? value : JSON.stringify(value, null, 2);
        return (
          <div key={key} className="space-y-1">
            <dt className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {key}
            </dt>
            <dd>
              <TruncatedCodeBlock
                code={code}
                language={isString ? "text" : "json"}
                copyText={code}
                wrapLongLines
              />
            </dd>
          </div>
        );
      })}
    </dl>
  );
};

const COMPACT_CODE_STYLE = {
  fontSize: "0.6875rem",
  padding: "0.4rem 0.6rem",
} as const;

// Force-override the `text-sm` Tailwind class baked into CodeBlock's inner
// <code> element so the params/output text actually shrinks.
const COMPACT_CODE_CLASS =
  "[&_code]:!text-[0.6875rem] [&_code]:!leading-[1rem] [&>pre]:!text-[0.6875rem]";

/**
 * Renders a CodeBlock that collapses long content to
 * TRUNCATED_CONTENT_MAX_LINES with a "Show N more lines" affordance over a
 * gradient fade. Used for both tool request bodies and tool response output
 * so neither side overruns the chat when a tool dumps a large JSON payload.
 */
const TruncatedCodeBlock = ({
  code,
  language,
  copyText,
  wrapLongLines = false,
}: {
  code: string;
  language: string;
  copyText: string;
  wrapLongLines?: boolean;
}) => {
  const lines = code.split("\n");

  return (
    <TruncatedContent lineCount={lines.length}>
      {(showAll) => (
        <CodeBlock
          code={
            showAll
              ? code
              : `${lines.slice(0, TRUNCATED_CONTENT_MAX_LINES).join("\n")}\n... (${
                  lines.length - TRUNCATED_CONTENT_MAX_LINES
                } more lines)`
          }
          language={language}
          wrapLongLines={wrapLongLines}
          contentStyle={COMPACT_CODE_STYLE}
          contentClassName={COMPACT_CODE_CLASS}
          className="border-border/50"
        >
          <CopyButton text={copyText} className="-translate-y-1" />
        </CodeBlock>
      )}
    </TruncatedContent>
  );
};

/** An error's text, in the one place a card shows it. */
const ToolErrorText = ({ text }: { text: string }) => (
  <div className="rounded-md bg-destructive/10 p-3 text-destructive text-xs whitespace-pre-wrap break-words select-text">
    {text}
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output?: ToolUIPart["output"];
  errorText?: ToolUIPart["errorText"];
  label?: string;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  label,
  ...props
}: ToolOutputProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const labelText = label ?? (errorText ? "Error" : "Response");

  const hasOutput = output !== undefined && output !== null;
  if (!hasOutput && !errorText) {
    return null;
  }

  const displayOutput = hasOutput ? normalizeToolOutput(output) : undefined;
  const images = hasOutput ? getDisplayableImages(output) : [];
  // An error is shown once. Its text is usually the result's own text, so
  // the two are one block; a result that says more than the error, or
  // something else, follows it.
  const error = splitErrorFromOutput(errorText, displayOutput);
  // A result with no text and no image: say so, never show the wrapper the
  // platform stores the result in.
  const isEmpty =
    !error &&
    images.length === 0 &&
    (displayOutput === undefined ||
      displayOutput === null ||
      displayOutput === "");

  let Output: ReactNode;
  if (isEmpty) {
    Output = (
      <p className="py-1 text-muted-foreground">
        The tool returned no content.
      </p>
    );
  } else if (
    error?.coversOutput ||
    displayOutput === "" ||
    displayOutput == null
  ) {
    // The error text says it all, or only images follow: they render below.
    Output = null;
  } else if (
    typeof displayOutput === "object" ||
    typeof displayOutput === "string"
  ) {
    // If output is a string, try to parse it as JSON for proper formatting
    let formattedOutput = displayOutput;
    if (typeof displayOutput === "string") {
      try {
        formattedOutput = JSON.parse(displayOutput);
      } catch {
        // Not valid JSON, use as-is
      }
    }
    const codeString =
      typeof formattedOutput === "object"
        ? JSON.stringify(formattedOutput, null, 2)
        : String(formattedOutput);

    Output = (
      <TruncatedCodeBlock
        code={codeString}
        language="json"
        copyText={codeString}
      />
    );
  } else {
    Output = <div>{String(displayOutput)}</div>;
  }

  const accent = errorText ? "bg-destructive" : "bg-emerald-400";

  return (
    <div
      ref={containerRef}
      className={cn("px-3 pb-3 pt-2 space-y-1.5", className)}
      {...props}
    >
      <SectionLabel accent={accent}>{labelText}</SectionLabel>
      {error ? <ToolErrorText text={error.text} /> : null}
      {Output ? (
        <div className="overflow-x-auto rounded-md text-xs text-foreground [&_table]:w-full">
          {Output}
        </div>
      ) : null}
      {images.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {images.map((image, index) => (
            // An inline data URI from the tool result, not a served asset.
            <img
              key={image.key}
              src={image.src}
              alt={`Returned by the tool, ${index + 1} of ${images.length}`}
              className="max-h-80 max-w-full rounded-md border object-contain"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

/**
 * What an error section shows for an error and the result that came with it.
 * `coversOutput` means the text already holds everything the result says, so
 * the result is not printed a second time.
 */
function splitErrorFromOutput(
  errorText: string | undefined,
  displayOutput: unknown,
): { text: string; coversOutput: boolean } | null {
  if (!errorText) return null;
  if (displayOutput === undefined || displayOutput === null) {
    return { text: errorText, coversOutput: true };
  }
  if (typeof displayOutput !== "string") {
    return { text: errorText, coversOutput: false };
  }
  const outputText = displayOutput.trim();
  if (errorText.includes(outputText)) {
    return { text: errorText, coversOutput: true };
  }
  // The result repeats the error and adds to it: show the longer text.
  if (outputText.includes(errorText.trim())) {
    return { text: outputText, coversOutput: true };
  }
  return { text: errorText, coversOutput: false };
}

/**
 * Entries of a plain-object input when at least one value is a multi-line
 * string; null otherwise (caller falls back to the JSON view).
 */
function getEntriesWithMultilineStrings(
  input: unknown,
): [string, unknown][] | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const entries = Object.entries(input);
  const hasMultilineString = entries.some(
    ([, value]) => typeof value === "string" && value.includes("\n"),
  );
  return hasMultilineString ? entries : null;
}

function normalizeToolOutput(output: ToolUIPart["output"]): unknown {
  if (!isMcpToolOutput(output)) {
    return output;
  }

  // An empty text is a result too. Falling through to the wrapper would show
  // the platform's own fields (`_meta`, `rawContent`) as if the tool sent them.
  if (output.content || output.structuredContent === undefined) {
    return withImageMarkers(output.content);
  }

  return output.structuredContent;
}

const DISPLAYABLE_IMAGE_MIME_TYPE = /^image\/(png|jpe?g|webp|gif)$/;
const BASE64_PAYLOAD = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The images of an MCP result, from its `rawContent` blocks. A block whose
 * payload was stripped for context, or whose type is not an image format the
 * browser shows, is left out rather than rendered broken.
 */
function getDisplayableImages(
  output: ToolUIPart["output"],
): { key: string; src: string }[] {
  if (!isMcpToolOutput(output) || !Array.isArray(output.rawContent)) {
    return [];
  }
  const images: { key: string; src: string }[] = [];
  output.rawContent.forEach((block: unknown, index: number) => {
    if (typeof block !== "object" || block === null) return;
    const { type, data, mimeType } = block as Record<string, unknown>;
    if (
      type === "image" &&
      typeof data === "string" &&
      typeof mimeType === "string" &&
      DISPLAYABLE_IMAGE_MIME_TYPE.test(mimeType) &&
      BASE64_PAYLOAD.test(data)
    ) {
      images.push({
        key: String(index),
        src: `data:${mimeType};base64,${data}`,
      });
    }
  });
  return images;
}

/**
 * Results stored before images had a text marker hold each image block as one
 * line of JSON with its base64 payload. Show the marker in its place.
 */
function withImageMarkers(content: string): string {
  if (!content.includes('"type":"image"')) return content;
  return content
    .split("\n")
    .map((line) => (isSerializedImageBlock(line) ? "[image]" : line))
    .join("\n");
}

function isSerializedImageBlock(line: string): boolean {
  if (!line.startsWith("{") || !line.includes('"type":"image"')) return false;
  try {
    const block: unknown = JSON.parse(line);
    return (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "image" &&
      typeof (block as { data?: unknown }).data === "string"
    );
  } catch {
    return false;
  }
}

function isMcpToolOutput(value: unknown): value is {
  content: string;
  structuredContent?: unknown;
  rawContent?: unknown;
  _meta?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    typeof value.content === "string"
  );
}
